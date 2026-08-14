import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseJsonc } from "./jsonc.ts";

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

const DEFAULT_MODE = "default";

/** `~/.pi/agent/pi-mode-config.jsonc` (respects PI_AGENT_DIR override). */
export function getConfigPath(): string {
	return join(getAgentDir(), "pi-mode-config.jsonc");
}

/** Shipped commented template, copied to the agent dir when the user file is missing. */
export function getExampleConfigPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "../config/config.example.jsonc");
}

/**
 * Built-in defaults when the file is absent or unreadable.
 * Only `default` — no permission block — so behavior matches vanilla pi.
 */
export const DEFAULT_CONFIG: PiModeConfig = {
	defaultMode: DEFAULT_MODE,
	commandWrappers: ["rtk", "time", "nice", "command"],
	modes: {
		[DEFAULT_MODE]: {},
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

const MINIMAL_TEMPLATE = `{
  "defaultMode": "default",
  "modes": {
    "default": {}
  }
}
`;

const ACTIONS = new Set<Action>(["allow", "deny", "ask", "classify"]);

function asAction(value: unknown, fallback: Action = "deny"): Action {
	return typeof value === "string" && ACTIONS.has(value as Action) ? (value as Action) : fallback;
}

function sanitizeSurfaceRule(rule: SurfaceRule): SurfaceRule {
	if (typeof rule === "string") return asAction(rule);
	const out: Record<string, Action> = {};
	for (const [pattern, action] of Object.entries(rule)) {
		out[pattern] = asAction(action);
	}
	return out;
}

function sanitizeModes(modes: Record<string, ModeConfig>): Record<string, ModeConfig> {
	const out: Record<string, ModeConfig> = {};
	for (const [name, mode] of Object.entries(modes)) {
		const permission = mode?.permission;
		out[name] = {
			...mode,
			permission: permission
				? Object.fromEntries(
						Object.entries(permission).map(([surface, rule]) => [surface, sanitizeSurfaceRule(rule)]),
					)
				: permission,
		};
	}
	return out;
}

function sanitizeVerdicts(raw: unknown): string[] {
	if (!Array.isArray(raw)) return DEFAULT_CONFIG.classifier.verdicts;
	const kept = raw.filter((v): v is string => typeof v === "string" && ACTIONS.has(v as Action));
	return kept.length > 0 ? kept : DEFAULT_CONFIG.classifier.verdicts;
}

/** Merge a user-parsed config over defaults and coerce unknown actions to deny. */
export function parseConfig(parsed: unknown): PiModeConfig {
	const p = (parsed ?? {}) as Partial<PiModeConfig>;
	const rawModes = p.modes;
	const modes =
		rawModes && typeof rawModes === "object" && !Array.isArray(rawModes) && Object.keys(rawModes).length > 0
			? (rawModes as Record<string, ModeConfig>)
			: DEFAULT_CONFIG.modes;
	const classifierIn = (p.classifier ?? {}) as Partial<ClassifierConfig>;
	return {
		defaultMode: typeof p.defaultMode === "string" ? p.defaultMode : DEFAULT_CONFIG.defaultMode,
		commandWrappers: Array.isArray(p.commandWrappers) ? p.commandWrappers : DEFAULT_CONFIG.commandWrappers,
		modes: sanitizeModes(structuredClone(modes)),
		classifier: {
			...DEFAULT_CONFIG.classifier,
			...classifierIn,
			fallback: asAction(classifierIn.fallback ?? DEFAULT_CONFIG.classifier.fallback),
			verdicts: sanitizeVerdicts(classifierIn.verdicts ?? DEFAULT_CONFIG.classifier.verdicts),
		},
		ask: { ...DEFAULT_CONFIG.ask, ...(p.ask ?? {}) },
	};
}

function templateBody(): string {
	const example = getExampleConfigPath();
	if (existsSync(example)) return readFileSync(example, "utf-8");
	return MINIMAL_TEMPLATE;
}

/** Write the commented template. Returns false if the write failed. */
export function writeDefaultConfigFile(configPath: string): boolean {
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, templateBody(), "utf-8");
		return true;
	} catch (err) {
		console.error(`[pi-mode] Failed to create ${configPath}: ${err}`);
		return false;
	}
}

export interface LoadConfigResult {
	config: PiModeConfig;
	path: string;
	/** True when the file did not exist and a template was written (or write failed). */
	created: boolean;
	error?: string;
}

/** Load and validate a pi-mode config at an explicit path. Missing → write template. */
export function loadConfigFromFile(configPath: string): LoadConfigResult {
	let created = false;
	if (!existsSync(configPath)) {
		writeDefaultConfigFile(configPath);
		created = true;
	}

	if (!existsSync(configPath)) {
		return { config: structuredClone(DEFAULT_CONFIG), path: configPath, created, error: "missing" };
	}

	try {
		return { config: parseConfig(parseJsonc(readFileSync(configPath, "utf-8"))), path: configPath, created };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[pi-mode] Failed to load ${configPath}: ${err}. Using defaults.`);
		return { config: structuredClone(DEFAULT_CONFIG), path: configPath, created, error: message };
	}
}

/** Load `~/.pi/agent/pi-mode-config.jsonc`, creating the commented template if absent. */
export function loadConfig(): PiModeConfig {
	return loadConfigFromFile(getConfigPath()).config;
}
