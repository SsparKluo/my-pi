import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILE_NAME = "tool-loadout.json";
const GLUE_TOOL_NAME = "tool_loadout";

export { CONFIG_FILE_NAME, GLUE_TOOL_NAME };

export interface ToolLoadoutConfig {
	hide: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueNames(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of names) {
		const trimmed = name.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result;
}

export function loadToolLoadoutConfig(agentDir: string): { hide: string[]; error?: string } {
	const path = join(agentDir, CONFIG_FILE_NAME);
	if (!existsSync(path)) return { hide: [] };

	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(value)) {
			return { hide: [], error: `${path}: expected a JSON object` };
		}
		if (value.hide !== undefined && (!Array.isArray(value.hide) || value.hide.some((item) => typeof item !== "string"))) {
			return { hide: [], error: `${path}: hide must be an array of strings` };
		}
		return { hide: uniqueNames(Array.isArray(value.hide) ? value.hide : []) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { hide: [], error: `${path}: ${message}` };
	}
}

/** Hide configured names that are actually declared, plus the glue tool itself. */
export function hiddenDeclarations(hide: readonly string[], declaredNames: readonly string[], selfName: string = GLUE_TOOL_NAME): string[] {
	const declared = new Set(declaredNames);
	const result: string[] = [];
	const seen = new Set<string>();
	for (const name of [...hide, selfName]) {
		if (!declared.has(name) || seen.has(name)) continue;
		seen.add(name);
		result.push(name);
	}
	return result;
}
