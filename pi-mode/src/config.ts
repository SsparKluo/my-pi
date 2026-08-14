import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseJsonc } from "./jsonc.ts";

/** A permission action. `classify` routes bash to bash-classify (or the AI engine). */
export type Action = "allow" | "deny" | "ask" | "classify";

export type BashClass = "READONLY" | "LOCAL_EFFECTS" | "EXTERNAL_EFFECTS" | "DANGEROUS" | "UNKNOWN";
export type BashRisk = "LOW" | "MEDIUM" | "HIGH";
export type ClassifierEngine = "bash-classify" | "model";

/** A surface's rules: a single action, or a pattern→action map (last-match-wins). */
export type SurfaceRule = Action | Record<string, Action>;

export interface PermissionRules {
	[surface: string]: SurfaceRule;
}

export interface ClassifyMap {
	byRisk?: Partial<Record<BashRisk, Action>>;
	byClass?: Partial<Record<BashClass, Action>>;
	/** LLM allowed answers. Omit `ask` for a hands-off mode. */
	verdicts?: string[];
	fallback?: Action;
}

export interface ModeConfig {
	onEnterPrompt?: string | null;
	onExitPrompt?: string | null;
	perTurnPrompt?: string | null;
	permission?: PermissionRules;
	/** Per-mode overlay on the global classifier maps. */
	classify?: ClassifyMap;
}

export interface ClassifierConfig {
	engine: ClassifierEngine;
	command: string;
	byRisk: Partial<Record<BashRisk, Action>>;
	byClass: Partial<Record<BashClass, Action>>;
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
		engine: "bash-classify",
		command: "bash-classify",
		byRisk: { LOW: "allow", MEDIUM: "ask", HIGH: "ask" },
		byClass: {},
		model: "anthropic/claude-haiku-4-5",
		verdicts: ["allow", "deny"],
		fallback: "ask",
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

const OPEN_PERMISSION: PermissionRules = { "*": "allow" };

/** Child surface/pattern keys overwrite the parent; unspecified keys are kept. */
export function mergePermissionRules(base: PermissionRules, over: PermissionRules): PermissionRules {
	const out: PermissionRules = { ...base };
	for (const [surface, rule] of Object.entries(over)) {
		const prev = out[surface];
		if (isPatternMap(rule) && isPatternMap(prev)) {
			out[surface] = { ...prev, ...rule };
		} else if (isPatternMap(rule) && (prev === undefined || prev === "allow")) {
			// Open parent + child's partial map: keep unspecified commands allowed.
			out[surface] = { "*": "allow", ...rule };
		} else {
			out[surface] = rule;
		}
	}
	return out;
}

function isPatternMap(rule: SurfaceRule | undefined): rule is Record<string, Action> {
	return !!rule && typeof rule === "object" && !Array.isArray(rule);
}

function mergeClassifyMaps(base?: ClassifyMap, over?: ClassifyMap): ClassifyMap | undefined {
	if (!base && !over) return undefined;
	return {
		byRisk: { ...base?.byRisk, ...over?.byRisk },
		byClass: { ...base?.byClass, ...over?.byClass },
		verdicts: over?.verdicts ?? base?.verdicts,
		fallback: over?.fallback ?? base?.fallback,
	};
}

/** `default` stays as written. Other modes inherit its permission + classify maps (or all-allow if it has none). */
export function inheritPermissions(modes: Record<string, ModeConfig>): Record<string, ModeConfig> {
	const parent = modes.default?.permission;
	const parentClassify = modes.default?.classify;
	const out: Record<string, ModeConfig> = {};
	for (const [name, mode] of Object.entries(modes)) {
		if (name === "default") {
			out[name] = mode;
			continue;
		}
		const child = mode?.permission;
		if (!parent && !child && !parentClassify && !mode?.classify) {
			out[name] = mode;
			continue;
		}
		const base = parent ?? (child ? OPEN_PERMISSION : undefined);
		out[name] = {
			...mode,
			permission: child && base ? mergePermissionRules(base, child) : child ?? (base ? structuredClone(base) : child),
			classify: mergeClassifyMaps(parentClassify, mode?.classify),
		};
	}
	return out;
}

function sanitizeClassifyMap(raw: unknown): ClassifyMap | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const rec = raw as ClassifyMap;
	const out: ClassifyMap = {};
	if (rec.byRisk && typeof rec.byRisk === "object") {
		out.byRisk = Object.fromEntries(
			Object.entries(rec.byRisk).map(([k, v]) => [k, asAction(v, "ask")]),
		) as ClassifyMap["byRisk"];
	}
	if (rec.byClass && typeof rec.byClass === "object") {
		out.byClass = Object.fromEntries(
			Object.entries(rec.byClass).map(([k, v]) => [k, asAction(v, "ask")]),
		) as ClassifyMap["byClass"];
	}
	if (Array.isArray(rec.verdicts)) {
		const kept = rec.verdicts.filter((v): v is string => typeof v === "string" && ACTIONS.has(v as Action));
		if (kept.length > 0) out.verdicts = kept;
	}
	if (rec.fallback !== undefined) out.fallback = asAction(rec.fallback);
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
			classify: sanitizeClassifyMap(mode?.classify),
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
	const classifyMaps = sanitizeClassifyMap(classifierIn) ?? {};
	const engine = classifierIn.engine === "model" ? "model" : DEFAULT_CONFIG.classifier.engine;
	return {
		defaultMode: typeof p.defaultMode === "string" ? p.defaultMode : DEFAULT_CONFIG.defaultMode,
		commandWrappers: Array.isArray(p.commandWrappers) ? p.commandWrappers : DEFAULT_CONFIG.commandWrappers,
		modes: inheritPermissions(sanitizeModes(structuredClone(modes))),
		classifier: {
			...DEFAULT_CONFIG.classifier,
			...classifierIn,
			engine,
			command: typeof classifierIn.command === "string" && classifierIn.command.trim()
				? classifierIn.command.trim()
				: DEFAULT_CONFIG.classifier.command,
			byRisk: { ...DEFAULT_CONFIG.classifier.byRisk, ...classifyMaps.byRisk },
			byClass: { ...DEFAULT_CONFIG.classifier.byClass, ...classifyMaps.byClass },
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
