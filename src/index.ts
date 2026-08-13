import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { PREVIEW_BASH_SUBJECT, showAskDialog } from "./ask.ts";
import { evaluateBashCommand } from "./bash.ts";
import {
	classifyCommands,
	collectAgentsMd,
	lastUserTexts,
	parseModelRef,
} from "./classifier.ts";
import { getConfigPath, loadConfig, type Action, type PiModeConfig } from "./config.ts";
import {
	evaluatePermission,
	extractSubject,
	SessionApprovals,
	subjectKind,
	visibleTools,
} from "./permission.ts";

const STATE_ENTRY = "pi-mode-state";
const EVENT_CHANGED = "pi-mode:changed";

type ChangeReason = "startup" | "resume" | "reload" | "switch";

/**
 * Layer 4 — mode lifecycle + permission + ask + bash cascade + AI classifier.
 */
export default function piMode(pi: ExtensionAPI): void {
	const config: PiModeConfig = loadConfig();

	let currentMode: string | undefined;
	let baselineTools: string[] | undefined;
	const approvals = new SessionApprovals();
	const classifyCache = new Map<string, Action>();
	let agentsMd = "";

	pi.registerFlag("pi-mode", {
		description: "Start in a specific pi-mode (e.g. --pi-mode plan)",
		type: "string",
	});

	function statusText(): string | undefined {
		if (!currentMode || currentMode === "normal") return undefined;
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

	function injectPrompt(prompt: string | null | undefined, kind: "enter" | "exit"): void {
		if (!prompt) return;
		pi.sendMessage({ customType: `pi-mode-${kind}`, content: prompt, display: true }, { triggerTurn: false });
	}

	function setMode(
		ctx: ExtensionContext,
		name: string,
		opts: { reason: ChangeReason; announce: boolean; persist: boolean },
	): void {
		if (name === currentMode) return; // no-op
		const previous = currentMode;

		if (opts.announce && previous && previous !== name) {
			injectPrompt(config.modes[previous]?.onExitPrompt, "exit");
		}

		currentMode = name;

		if (opts.persist) {
			pi.appendEntry(STATE_ENTRY, { mode: name, ts: Date.now() });
		}

		if (opts.announce) {
			injectPrompt(config.modes[name]?.onEnterPrompt, "enter");
		}

		pi.events.emit(EVENT_CHANGED, { mode: name, previous, reason: opts.reason });
		applyToolsForMode(name);
		setStatus(ctx);
	}

	function applyToolsForMode(name: string): void {
		const rules = config.modes[name]?.permission;
		if (!rules) {
			if (baselineTools) {
				pi.setActiveTools(baselineTools);
				baselineTools = undefined;
			}
			return;
		}
		if (!baselineTools) baselineTools = pi.getActiveTools();
		pi.setActiveTools(visibleTools(rules, baselineTools));
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
		setMode(ctx, name, { reason: "switch", announce: true, persist: true });
		ctx.ui.notify(`Switched to ${name} mode`, "info");
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

	pi.registerCommand("ask-preview", {
		description: "Preview the pi-mode ask dialog (does not run anything)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("ask-preview needs a TUI", "warning");
				return;
			}
			const which = args?.trim() === "write" ? "write" : "bash";
			const verdict =
				which === "write"
					? {
							action: "ask" as const,
							surface: "write",
							pattern: "**/*.md",
							subject: "notes/TODO.md",
							kind: "path" as const,
					  }
					: {
							action: "ask" as const,
							surface: "bash",
							pattern: "git push *",
							subject: PREVIEW_BASH_SUBJECT,
							kind: "command" as const,
					  };
			const decision = await showAskDialog(ctx, verdict, config.ask);
			ctx.ui.notify(`ask-preview: ${decision}`, "info");
		},
	});

	// perTurn prompt: ephemeral system-prompt append, recomputed each turn.
	pi.on("before_agent_start", async (event) => {
		agentsMd = collectAgentsMd(event.systemPromptOptions?.contextFiles);
		if (!currentMode) return;
		const prompt = config.modes[currentMode]?.perTurnPrompt;
		if (prompt) {
			return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!currentMode) return;
		const rules = config.modes[currentMode]?.permission;
		if (!rules) return;

		const surface = event.toolName;
		const subject = extractSubject(surface, event.input as Record<string, unknown>);
		const kind = subjectKind(surface);
		if (approvals.allows(surface, subject, kind, ctx.cwd)) return;

		const verdict =
			surface === "bash"
				? evaluateBashCommand(
						subject,
						rules,
						config.commandWrappers,
						config.classifier.wholeCommandThreshold,
						ctx.cwd,
				  )
				: evaluatePermission(rules, surface, subject, ctx.cwd);
		let action = verdict.action;
		if (action === "classify") {
			action = await classifyVerdict(ctx, verdict.subject, verdict.classifyTargets ?? [verdict.subject]);
		}
		if (action === "allow") return;
		if (action === "deny") {
			return {
				block: true,
				reason: `pi-mode (${currentMode}): ${surface} denied: ${subject}`,
			};
		}
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `pi-mode (${currentMode}): ${surface} requires approval (no UI)`,
			};
		}
		const decision = await showAskDialog(ctx, { ...verdict, action: "ask" }, config.ask);
		if (decision === "allow_once") return;
		if (decision === "allow_session") {
			approvals.add(surface, verdict.pattern ?? "*");
			return;
		}
		return {
			block: true,
			reason: `pi-mode (${currentMode}): ${surface} denied by user`,
		};
	});

	// Restore (resume) or initialize (startup) the active mode.
	async function classifyVerdict(ctx: ExtensionContext, wholeCommand: string, targets: string[]): Promise<Action> {
		const ref = parseModelRef(config.classifier.model);
		const model = ref ? ctx.modelRegistry.find(ref.provider, ref.modelId) : undefined;
		return classifyCommands({
			config: config.classifier,
			wholeCommand,
			targets,
			agentsMd,
			userMessages: lastUserTexts(ctx.sessionManager.getBranch()),
			cache: classifyCache,
			complete: async (call) => {
				if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
					throw new Error("classifier model unavailable");
				}
				const result = await ctx.modelRegistry.complete(
					model,
					{
						systemPrompt: call.systemPrompt,
						messages: [{ role: "user", content: call.userContent, timestamp: Date.now() }],
					},
					{
						reasoningEffort: "low",
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
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		approvals.clear();
		classifyCache.clear();
		agentsMd = "";
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === STATE_ENTRY)
			.pop() as { data?: { mode?: string } } | undefined;
		const persisted = stateEntry?.data?.mode;

		const flagMode = pi.getFlag("pi-mode");
		const isValid = (n: unknown): n is string => typeof n === "string" && !!config.modes[n];

		if (isValid(flagMode)) {
			// Explicit --pi-mode flag: treat as a switch.
			setMode(ctx, flagMode, { reason: "switch", announce: true, persist: true });
		} else if (isValid(persisted)) {
			// Resume: silently restore, no re-announce.
			setMode(ctx, persisted, { reason: "resume", announce: false, persist: false });
		} else {
			// First start: enter the configured default.
			const def = config.modes[config.defaultMode] ? config.defaultMode : "normal";
			setMode(ctx, def, { reason: "startup", announce: true, persist: true });
		}
	});
}
