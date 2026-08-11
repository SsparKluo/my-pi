import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolPromptSpec } from "./system-prompt-core.ts";

const CONFIG_FILE_NAME = "system-prompt.json";

export interface SystemPromptConfig {
	basePrompt?: string;
	general?: string[];
	tools?: Record<string, ToolPromptSpec>;
}

interface ConfigReadResult {
	config?: SystemPromptConfig;
	error?: string;
	absent?: boolean;
}

export interface EffectiveConfig {
	basePrompt?: string;
	general: string[];
	tools: Record<string, ToolPromptSpec>;
	errors: string[];
	/** True only when neither the global nor the project config file exists. */
	absent: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfig(path: string): ConfigReadResult {
	if (!existsSync(path)) return { absent: true };

	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(value)) {
			return { error: `${path}: expected a JSON object` };
		}

		const basePrompt = value.basePrompt;
		if (basePrompt !== undefined && typeof basePrompt !== "string") {
			return { error: `${path}: basePrompt must be a string` };
		}

		const general = value.general;
		if (
			general !== undefined &&
			(!Array.isArray(general) || general.some((item) => typeof item !== "string"))
		) {
			return { error: `${path}: general must be an array of strings` };
		}

		const tools = value.tools;
		if (tools !== undefined && !isRecord(tools)) {
			return { error: `${path}: tools must be an object` };
		}

		const parsedTools: Record<string, ToolPromptSpec> = {};
		if (isRecord(tools)) {
			for (const [name, rawTool] of Object.entries(tools)) {
				if (!isRecord(rawTool) || typeof rawTool.snippet !== "string" || !rawTool.snippet.trim()) {
					return { error: `${path}: tools.${name}.snippet must be a non-empty string` };
				}
				if (
					!Array.isArray(rawTool.guidelines) ||
					rawTool.guidelines.some((item) => typeof item !== "string")
				) {
					return { error: `${path}: tools.${name}.guidelines must be an array of strings` };
				}
				parsedTools[name] = {
					snippet: rawTool.snippet.trim(),
					guidelines: rawTool.guidelines.map((item) => item.trim()).filter(Boolean),
				};
			}
		}

		return {
			config: {
				basePrompt: typeof basePrompt === "string" && basePrompt.trim() ? basePrompt : undefined,
				general: Array.isArray(general) ? general.map((item) => item.trim()).filter(Boolean) : undefined,
				tools: parsedTools,
			},
			absent: false,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `${path}: ${message}`, absent: false };
	}
}

export interface LoadConfigOptions {
	cwd: string;
	trusted: boolean;
	agentDir: string;
	configDirName: string;
}

/** Merge global and project configs. Project wins for basePrompt; general and tools concatenate. */
export function loadConfig({ cwd, trusted, agentDir, configDirName }: LoadConfigOptions): EffectiveConfig {
	const globalResult = readConfig(join(agentDir, CONFIG_FILE_NAME));
	const projectResult = trusted ? readConfig(join(cwd, configDirName, CONFIG_FILE_NAME)) : { absent: true };

	return {
		basePrompt: projectResult.config?.basePrompt ?? globalResult.config?.basePrompt,
		general: [
			...(globalResult.config?.general ?? []),
			...(projectResult.config?.general ?? []),
		],
		tools: {
			...(globalResult.config?.tools ?? {}),
			...(projectResult.config?.tools ?? {}),
		},
		errors: [globalResult.error, projectResult.error].filter((error): error is string => Boolean(error)),
		absent: (globalResult.absent ?? false) && (projectResult.absent ?? false),
	};
}
