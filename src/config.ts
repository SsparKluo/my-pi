import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** A permission action. `classify` routes bash to the AI classifier. */
export type Action = "allow" | "deny" | "ask" | "classify";

/** A surface's rules: a single action, or a pattern→action map (last-match-wins). */
export type SurfaceRule = Action | Record<string, Action>;

export interface PermissionRules {
	[surface: string]: SurfaceRule;
}

export interface ModeConfig {
	onEnterPrompt?: string | null;
	onExitPrompt?: string | null;
	perTurnPrompt?: string | null;
	permission?: PermissionRules;
}

export interface ClassifierConfig {
	model: string;
	verdicts: string[];
	fallback: Action;
	cache: boolean;
	wholeCommandThreshold: number;
	prompt?: string | null;
}

export interface AskConfig {
	maxBlockHeight: number;
}

export interface PiModeConfig {
	defaultMode: string;
	commandWrappers: string[];
	modes: Record<string, ModeConfig>;
	classifier: ClassifierConfig;
	ask: AskConfig;
}

/** `~/.pi/pi-mode` — sibling of pi's agent dir (respects PI_AGENT_DIR override). */
export function getConfigDir(): string {
	return join(dirname(getAgentDir()), "pi-mode");
}

export function getConfigPath(): string {
	return join(getConfigDir(), "config.json");
}

/** Built-in defaults; mirror config/config.example.json. Used when no user config exists. */
export const DEFAULT_CONFIG: PiModeConfig = {
	defaultMode: "normal",
	commandWrappers: ["rtk", "time", "nice", "command"],
	modes: {
		normal: {
			onEnterPrompt: null,
			onExitPrompt: null,
			perTurnPrompt: null,
		},
		plan: {
			onEnterPrompt:
				"You are now in PLAN MODE (read-only). Investigate and produce a plan. You may only edit *.md files; do not modify code.",
			onExitPrompt: "PLAN MODE ended. Full permissions restored.",
			perTurnPrompt:
				"Current mode: plan — read-only; *.md writes only; bash restricted to a read-only allowlist.",
			permission: {
				"*": "ask",
				read: "allow",
				grep: "allow",
				find: "allow",
				ls: "allow",
				write: { "*": "deny", "**/*.md": "allow" },
				edit: { "*": "deny", "**/*.md": "allow" },
				bash: {
					"*": "deny",
					ls: "allow",
					"ls *": "allow",
					"cat *": "allow",
					"head *": "allow",
					"tail *": "allow",
					"grep *": "allow",
					"rg *": "allow",
					"find *": "allow",
					"fd *": "allow",
					"git status": "allow",
					"git diff *": "allow",
					"git log *": "allow",
					"git branch": "allow",
					"git show *": "allow",
					pwd: "allow",
					"tree *": "allow",
					"wc *": "allow",
				},
			},
		},
		auto: {
			onEnterPrompt:
				"You are in AUTO MODE. Bash commands are auto-approved by a safety classifier; file access is unrestricted.",
			onExitPrompt: "AUTO MODE ended.",
			perTurnPrompt:
				"Current mode: auto — bash auto-approved by a safety classifier; file access unrestricted.",
			permission: { "*": "allow", bash: "classify" },
		},
	},
	classifier: {
		model: "anthropic/claude-haiku-4-5",
		verdicts: ["allow", "deny"],
		fallback: "deny",
		cache: true,
		wholeCommandThreshold: 2,
		prompt: null,
	},
	ask: { maxBlockHeight: 10 },
};

/** Merge a user-parsed config over defaults (forgiving: fills missing top-level fields). */
function mergeConfig(parsed: unknown): PiModeConfig {
	const p = (parsed ?? {}) as Partial<PiModeConfig>;
	const modes =
		p.modes && typeof p.modes === "object"
			? (p.modes as Record<string, ModeConfig>)
			: DEFAULT_CONFIG.modes;
	return {
		defaultMode: typeof p.defaultMode === "string" ? p.defaultMode : DEFAULT_CONFIG.defaultMode,
		commandWrappers: Array.isArray(p.commandWrappers) ? p.commandWrappers : DEFAULT_CONFIG.commandWrappers,
		modes: structuredClone(modes),
		classifier: { ...DEFAULT_CONFIG.classifier, ...(p.classifier ?? {}) },
		ask: { ...DEFAULT_CONFIG.ask, ...(p.ask ?? {}) },
	};
}

/** Load `~/.pi/pi-mode/config.json`, falling back to defaults on absence or error. */
export function loadConfig(): PiModeConfig {
	const path = getConfigPath();
	if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
	try {
		return mergeConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (err) {
		console.error(`[pi-mode] Failed to load ${path}: ${err}. Using defaults.`);
		return structuredClone(DEFAULT_CONFIG);
	}
}
