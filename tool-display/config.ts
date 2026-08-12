/**
 * Global config loader for tool-display.
 *
 * Reads ~/.pi/agent/tool-display.json (global only — no project-level merge).
 * Mirrors the validation style of system-prompt-config.ts in this repo.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export type DiffMode = "auto" | "single" | "dual";

export type ToolName =
	| "read"
	| "write"
	| "edit"
	| "bash"
	| "grep"
	| "find"
	| "ls"
	| "ffgrep"
	| "fffind";

export const ALL_TOOL_NAMES: readonly ToolName[] = [
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
	"ffgrep",
	"fffind",
];

export interface ToolDisplayConfig {
	/** Tail output lines shown for a collapsed bash result. */
	bashPreviewLines: number;
	/** On Ctrl+O expand, show the full command above the output (req #2). */
	bashRevealCommand: boolean;
	/** Collapsed read preview: number of leading content lines, or 0 for a "loaded N lines" summary only. */
	readPreviewLines: number;
	/** Diff layout selection. */
	diffMode: DiffMode;
	/** Terminal width at/above which "auto" switches to side-by-side. */
	diffColumnWidth: number;
	/** Syntax-highlight diff context lines via pi's built-in highlightCode. */
	diffSyntaxHighlight: boolean;
	/** Per-tool opt-out. A tool stays on pi's built-in renderer when false. */
	enabled: Record<ToolName, boolean>;
}

export const DEFAULT_CONFIG: ToolDisplayConfig = {
	bashPreviewLines: 5,
	bashRevealCommand: true,
	readPreviewLines: 0,
	diffMode: "auto",
	diffColumnWidth: 100,
	diffSyntaxHighlight: true,
	enabled: {
		read: true,
		write: true,
		edit: true,
		bash: true,
		grep: true,
		find: true,
		ls: true,
		ffgrep: true,
		fffind: true,
	},
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "tool-display.json");
const DIFF_MODES: readonly DiffMode[] = ["auto", "single", "dual"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

export interface LoadConfigResult {
	config: ToolDisplayConfig;
	/** Path that was read, when the file exists. */
	path: string;
	/** True when the file does not exist (all defaults used). */
	absent: boolean;
	/** Validation/parse errors collected per-field. Empty when valid. */
	errors: string[];
}

/** Load and validate a tool-display config at an explicit path, applying defaults for missing/invalid fields. */
export function loadConfigFromFile(configPath: string): LoadConfigResult {
	const errors: string[] = [];

	if (!existsSync(configPath)) {
		return { config: { ...DEFAULT_CONFIG, enabled: { ...DEFAULT_CONFIG.enabled } }, path: configPath, absent: true, errors };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			config: { ...DEFAULT_CONFIG, enabled: { ...DEFAULT_CONFIG.enabled } },
			path: configPath,
			absent: false,
			errors: [`${configPath}: ${message}`],
		};
	}

	if (!isRecord(raw)) {
		return {
			config: { ...DEFAULT_CONFIG, enabled: { ...DEFAULT_CONFIG.enabled } },
			path: configPath,
			absent: false,
			errors: [`${configPath}: expected a JSON object`],
		};
	}

	const config: ToolDisplayConfig = { ...DEFAULT_CONFIG, enabled: { ...DEFAULT_CONFIG.enabled } };

	const bashPreviewLines = raw.bashPreviewLines;
	if (bashPreviewLines !== undefined) {
		if (isNonNegativeInt(bashPreviewLines)) {
			config.bashPreviewLines = bashPreviewLines;
		} else {
			errors.push("bashPreviewLines must be a non-negative integer");
		}
	}

	const bashRevealCommand = raw.bashRevealCommand;
	if (bashRevealCommand !== undefined) {
		if (typeof bashRevealCommand === "boolean") {
			config.bashRevealCommand = bashRevealCommand;
		} else {
			errors.push("bashRevealCommand must be a boolean");
		}
	}

	const readPreviewLines = raw.readPreviewLines;
	if (readPreviewLines !== undefined) {
		if (isNonNegativeInt(readPreviewLines)) {
			config.readPreviewLines = readPreviewLines;
		} else {
			errors.push("readPreviewLines must be a non-negative integer");
		}
	}

	const diffMode = raw.diffMode;
	if (diffMode !== undefined) {
		if (typeof diffMode === "string" && (DIFF_MODES as readonly string[]).includes(diffMode)) {
			config.diffMode = diffMode as DiffMode;
		} else {
			errors.push(`diffMode must be one of ${DIFF_MODES.join(", ")}`);
		}
	}

	const diffColumnWidth = raw.diffColumnWidth;
	if (diffColumnWidth !== undefined) {
		if (isNonNegativeInt(diffColumnWidth) && diffColumnWidth > 0) {
			config.diffColumnWidth = diffColumnWidth;
		} else {
			errors.push("diffColumnWidth must be a positive integer");
		}
	}

	const diffSyntaxHighlight = raw.diffSyntaxHighlight;
	if (diffSyntaxHighlight !== undefined) {
		if (typeof diffSyntaxHighlight === "boolean") {
			config.diffSyntaxHighlight = diffSyntaxHighlight;
		} else {
			errors.push("diffSyntaxHighlight must be a boolean");
		}
	}

	const enabled = raw.enabled;
	if (enabled !== undefined) {
		if (!isRecord(enabled)) {
			errors.push("enabled must be an object");
		} else {
			for (const name of ALL_TOOL_NAMES) {
				const flag = enabled[name];
				if (flag === undefined) {
					continue;
				}
				if (typeof flag === "boolean") {
					config.enabled[name] = flag;
				} else {
					errors.push(`enabled.${name} must be a boolean`);
				}
			}
			for (const key of Object.keys(enabled)) {
				if (!(ALL_TOOL_NAMES as readonly string[]).includes(key)) {
					errors.push(`enabled has unknown tool "${key}"`);
				}
			}
		}
	}

	return { config, path: configPath, absent: false, errors };
}

/** Load and validate the global tool-display config (~/.pi/agent/tool-display.json). */
export function loadConfig(): LoadConfigResult {
	return loadConfigFromFile(CONFIG_PATH);
}
