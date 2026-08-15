import { randomUUID } from "node:crypto";
import {
	resolveModelScopeWithDiagnostics,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { showAskDialog } from "./ask.ts";
import { evaluateBashCommand } from "./bash.ts";
import {
	createBashClassifyRunner,
	gradeBashUnits,
	mergeClassifyMaps,
	mostRestrictiveAction,
} from "./bash-classify.ts";
import {
	classifyCommands,
	collectAgentsMd,
	conversationWindow,
} from "./classifier.ts";
import { getConfigPath, loadConfig, type Action, type GradeAction, type PiModeConfig } from "./config.ts";
import { reportHerdrMode, setHerdrBlocked } from "./herdr.ts";
import {
	applyExternalPathGate,
	evaluatePermission,
	extractSubject,
	reconcileTools,
	SessionApprovals,
	subjectKind,
} from "./permission.ts";
import { findPersistedMode, STATE_ENTRY } from "./restore.ts";

const EVENT_CHANGED = "pi-mode:changed";

type ChangeReason = "startup" | "resume" | "reload" | "switch";

/**
 * Layer 4 — mode lifecycle + permission + ask + bash cascade + AI classifier.
 */
export default function piMode(pi: ExtensionAPI): void {
	const config: PiModeConfig = loadConfig();
	const bashClassify = createBashClassifyRunner(config.bashClassify);

	let currentMode: string | undefined;
	// Mode active when the last user message was sent. Drives which prompt
	// (perTurn vs onExit+onEnter) the next message carries.
	let lastSentMode: string | undefined;
	const approvals = new SessionApprovals();
	const classifyCache = new Map<string, Action>();
	let agentsMd = "";
	let hiddenTools: string[] = [];

	pi.registerFlag("pi-mode", {
		description: "Start in a specific pi-mode (e.g. --pi-mode plan)",
		type: "string",
	});

	function statusText(): string | undefined {
		if (!currentMode || currentMode === "default") return undefined;
		const icon = currentMode === "plan" ? "⏸" : currentMode === "auto" ? "⚡" : "●";
		return `${icon} ${currentMode}`;
	}

	function setStatus(ctx: ExtensionContext): void {
		const text = statusText();
		if (text) {
			const color = currentMode === "plan" ? "warning" : "accent";
			ctx.ui.setStatus("pi-mode", ctx.ui.theme.fg(color, text));
		} else {
			ctx.ui.setStatus("pi-mode", undefined);
		}
	}

	function setMode(
		ctx: ExtensionContext,
		name: string,
		opts: { reason: ChangeReason; persist: boolean },
	): void {
		if (name === currentMode) return; // no-op
		const previous = currentMode;
		currentMode = name;

		if (opts.persist) {
			pi.appendEntry(STATE_ENTRY, { mode: name, ts: Date.now() });
		}

		pi.events.emit(EVENT_CHANGED, { mode: name, previous, reason: opts.reason });
		applyToolsForMode(name);
		setStatus(ctx);
		reportHerdrMode(name);
	}

	function applyToolsForMode(name: string): void {
		const next = reconcileTools(
			config.modes[name]?.permission,
			pi.getAllTools().map((t) => t.name),
			pi.getActiveTools(),
			hiddenTools,
		);
		hiddenTools = next.hidden;
		pi.setActiveTools(next.active);
	}

	function switchTo(ctx: ExtensionContext, name: string): boolean {
		if (!config.modes[name]) {
			const available = Object.keys(config.modes).join(", ") || "(none defined)";
			ctx.ui.notify(`Unknown mode "${name}". Available: ${available}`, "error");
			return false;
		}
		if (name === currentMode) {
			ctx.ui.notify(`Already in ${name} mode`, "info");
			return true;
		}
		setMode(ctx, name, { reason: "switch", persist: true });
		return true;
	}

	function modeNames(): string[] {
		return Object.keys(config.modes);
	}

	async function showSelector(ctx: ExtensionContext): Promise<void> {
		const names = modeNames();
		if (names.length === 0) {
			ctx.ui.notify(`No modes defined in ${getConfigPath()}`, "warning");
			return;
		}
		const choice = await ctx.ui.select(`Switch mode (current: ${currentMode ?? "none"})`, names);
		if (choice && choice !== currentMode) {
			switchTo(ctx, choice);
		}
	}

	pi.registerCommand("mode", {
		description: "Switch pi-mode (usage: /mode [name]; no arg shows a selector)",
		handler: async (args, ctx) => {
			const name = args?.trim();
			if (name) {
				switchTo(ctx, name);
			} else {
				await showSelector(ctx);
			}
		},
	});

	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Cycle pi-mode",
		handler: async (ctx) => {
			const names = modeNames();
			if (names.length === 0) return;
			const idx = currentMode ? names.indexOf(currentMode) : -1;
			const next = names[(idx + 1) % names.length];
			if (next && next !== currentMode) {
				switchTo(ctx, next);
			}
		},
	});

	type ModePrompt = { prompt: string; kind: "per" | "transition"; from?: string; to: string };

	const modeIcon = (m?: string): string => (m === "plan" ? "⏸" : m === "auto" ? "⚡" : "●");

	/**
	 * Mode prompt to emit at send time, based on the transition since the last
	 * sent message: same mode → perTurnPrompt (kind "per"); mode change (or first
	 * message) → onExitPrompt(prev) + onEnterPrompt(curr) (kind "transition").
	 * onEnter and perTurn are mutually exclusive.
	 */
	function promptForMessage(): ModePrompt | undefined {
		const curr = currentMode;
		if (!curr) return undefined;
		const currMode = config.modes[curr];
		if (lastSentMode === curr) {
			const per = currMode?.perTurnPrompt;
			return per ? { prompt: per, kind: "per", to: curr } : undefined;
		}
		const parts: string[] = [];
		const prevMode = lastSentMode ? config.modes[lastSentMode] : undefined;
		if (prevMode?.onExitPrompt) parts.push(prevMode.onExitPrompt);
		if (currMode?.onEnterPrompt) parts.push(currMode.onEnterPrompt);
		if (parts.length === 0) return undefined;
		return { prompt: parts.join("\n\n"), kind: "transition", from: lastSentMode, to: curr };
	}

	// Transition blocks render as a compact label (never the raw prompt text);
	// "per" blocks are display:false so they reach the model but stay invisible.
	pi.registerMessageRenderer("pi-mode-prompt", (message, _opts, theme) => {
		const d = message.details as { from?: string; to?: string } | undefined;
		const to = d?.to;
		const label = to === "default"
			? `${modeIcon(d?.from)} left ${d?.from ?? "mode"}`
			: `${modeIcon(to)} entered ${to ?? "mode"}`;
		return new Text(theme.fg("muted", label), 0, 0);
	});

	// Emit the mode prompt as its own block at send time — separate from the
	// user's message and NEVER in the system prompt (appending there would
	// invalidate the KV-cache prefix every turn). sendMessage appends the block
	// during the input event, before the user message is committed, so it
	// precedes the user message in both the transcript and the model context.
	pi.on("input", async (event) => {
		if (event.streamingBehavior) return; // only fresh messages, not mid-stream steers
		const result = promptForMessage();
		lastSentMode = currentMode;
		if (result) {
			pi.sendMessage(
				{
					customType: "pi-mode-prompt",
					content: result.prompt,
					display: result.kind === "transition",
					details: { kind: result.kind, from: result.from, to: result.to },
				},
				{ triggerTurn: false },
			);
		}
		// Returning void lets the user's message proceed unchanged.
	});

	// Reconcile tools each turn (mode prompts are emitted as a block via the
	// input event, not here — and never the system prompt).
	pi.on("before_agent_start", async (event) => {
		agentsMd = collectAgentsMd(event.systemPromptOptions?.contextFiles);
		if (currentMode) applyToolsForMode(currentMode);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!currentMode) return;
		const rules = config.modes[currentMode]?.permission;
		if (!rules) return;

		const surface = event.toolName;
		const subject = extractSubject(surface, event.input as Record<string, unknown>);
		const kind = subjectKind(surface);
		if (kind !== "command" && approvals.allows(surface, subject, kind, ctx.cwd)) return;

		let verdict =
			surface === "bash"
				? evaluateBashCommand(
						subject,
						rules,
						config.commandWrappers,
						config.bashClassify.wholeCommandThreshold,
						ctx.cwd,
				  )
				: applyExternalPathGate(
						evaluatePermission(rules, surface, subject, ctx.cwd),
						rules,
						ctx.cwd,
				  );
		let action = verdict.action;
		if (action === "classify") {
			const targets = verdict.classifyTargets ?? [verdict.subject];
			const maps = mergeClassifyMaps(
				config.bashClassify,
				currentMode ? config.modes[currentMode]?.classify : undefined,
			);
			const gradeFallback: GradeAction =
				config.bashClassify.fallback === "allow" || config.bashClassify.fallback === "deny"
					? config.bashClassify.fallback
					: "ask";
			const graded = await gradeBashUnits(targets, maps, gradeFallback, bashClassify);
			const needsLlm = graded.filter((g) => g.action === "model").map((g) => g.unit);
			const rest = graded.filter((g) => g.action !== "model").map((g) => g.action as Action);
			if (needsLlm.length > 0) {
				rest.push(await classifyVerdict(ctx, verdict.subject, needsLlm));
			}
			action = mostRestrictiveAction(rest, config.model.fallback);
		}
		if (action === "allow") return;
		if (action === "deny") {
			return {
				block: true,
				reason: `pi-mode (${currentMode}): ${surface} denied: ${subject}`,
			};
		}
		if (kind === "command") {
			const units = verdict.askUnits ?? [subject];
			const pending = units.filter((unit) => !approvals.allows("bash", unit, "command", ctx.cwd));
			if (pending.length === 0) return;
			verdict = { ...verdict, askUnits: pending };
		}
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `pi-mode (${currentMode}): ${surface} requires approval (no UI)`,
			};
		}
		const askLabel = verdict.askUnits?.length
			? `ask · ${verdict.askUnits.join(" · ")}`
			: `ask · ${surface}`;
		setHerdrBlocked(pi, true, askLabel);
		let decision: "allow_once" | "allow_session" | "deny";
		try {
			decision = await showAskDialog(ctx, { ...verdict, action: "ask" }, config.ask);
		} finally {
			setHerdrBlocked(pi, false);
		}
		if (decision === "allow_once") return;
		if (decision === "allow_session") {
			if (verdict.askUnits && verdict.askUnits.length > 0) {
				for (const unit of verdict.askUnits) approvals.add("bash", unit);
			} else {
				approvals.add(surface, verdict.pattern ?? "*");
			}
			return;
		}
		return {
			block: true,
			reason: `pi-mode (${currentMode}): ${surface} denied by user`,
		};
	});

	// Restore (resume) or initialize (startup) the active mode.
	async function classifyVerdict(ctx: ExtensionContext, wholeCommand: string, targets: string[]): Promise<Action> {
		const override = currentMode ? config.modes[currentMode]?.model : undefined;
		const classifier = {
			...config.model,
			verdicts: override?.verdicts ?? config.model.verdicts,
			fallback: override?.fallback ?? config.model.fallback,
		};
		const { scopedModels } = await resolveModelScopeWithDiagnostics(
			[classifier.model, ...(classifier.fallbackModels ?? [])],
			{ getAvailable: async () => ctx.modelRegistry.getAvailable() } as unknown as ModelRuntime,
		);
		const chain = scopedModels.filter((s) => ctx.modelRegistry.hasConfiguredAuth(s.model));
		return classifyCommands({
			config: classifier,
			wholeCommand,
			targets,
			agentsMd,
			conversation: conversationWindow(ctx.sessionManager.getBranch()),
			cache: classifyCache,
			complete: async (call) => {
				let lastError: unknown = new Error("classifier model unavailable");
				for (const candidate of chain) {
					try {
						const result = await ctx.modelRegistry.complete(
							candidate.model,
							{
								systemPrompt: call.systemPrompt,
								messages: [{ role: "user", content: call.userContent, timestamp: Date.now() }],
							},
							{
								reasoningEffort: candidate.thinkingLevel ?? "low",
								cacheRetention: "none",
								sessionId: randomUUID(),
								signal: ctx.signal,
							},
						);
						if (result.errorMessage) throw new Error(result.errorMessage);
						return result.content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text)
							.join("");
					} catch (err) {
						lastError = err;
					}
				}
				throw lastError;
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		approvals.clear();
		classifyCache.clear();
		agentsMd = "";
		// Walk the active branch (leaf → root), not file order: after a rewind
		// the file tail may hold state entries from an abandoned branch.
		const persisted = findPersistedMode(ctx.sessionManager.getBranch());

		const flagMode = pi.getFlag("pi-mode");
		const isValid = (n: unknown): n is string => typeof n === "string" && !!config.modes[n];

		if (isValid(flagMode)) {
			// Explicit --pi-mode flag: first message announces onEnter.
			setMode(ctx, flagMode, { reason: "switch", persist: true });
		} else if (isValid(persisted)) {
			// Resume: mode was already active → first message gets perTurn, not onEnter.
			setMode(ctx, persisted, { reason: "resume", persist: false });
			lastSentMode = persisted;
		} else {
			// First start: enter the configured default.
			const def = config.modes[config.defaultMode] ? config.defaultMode : "default";
			setMode(ctx, def, { reason: "startup", persist: true });
		}
	});
}
