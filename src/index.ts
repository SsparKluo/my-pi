import { Key } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfigPath, loadConfig, type PiModeConfig } from "./config.ts";

const STATE_ENTRY = "pi-mode-state";
const EVENT_CHANGED = "pi-mode:changed";

type ChangeReason = "startup" | "resume" | "reload" | "switch";

/**
 * Layer 1 — mode lifecycle (prompt-only). Loads config, exposes `/mode`
 * (command + selector), a cycle shortcut, and `--mode`; persists/restores the
 * active mode per session; injects onEnter/onExit (visible) and perTurn
 * (system-prompt) prompts; and broadcasts `pi-mode:changed` so other components
 * (and the footer status) can react. Permission gating, bash, and the
 * classifier arrive in later layers.
 */
export default function piMode(pi: ExtensionAPI): void {
	const config: PiModeConfig = loadConfig();

	let currentMode: string | undefined;

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
		setStatus(ctx);
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

	// perTurn prompt: ephemeral system-prompt append, recomputed each turn.
	pi.on("before_agent_start", async (event) => {
		if (!currentMode) return;
		const prompt = config.modes[currentMode]?.perTurnPrompt;
		if (prompt) {
			return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
		}
	});

	// Restore (resume) or initialize (startup) the active mode.
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === STATE_ENTRY)
			.pop() as { data?: { mode?: string } } | undefined;
		const persisted = stateEntry?.data?.mode;

		const flagMode = pi.getFlag("pi-mode");
		const isValid = (n: unknown): n is string => typeof n === "string" && !!config.modes[n];

		if (isValid(flagMode)) {
			// Explicit --mode flag: fresh switch.
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
