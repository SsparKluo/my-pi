import {
	CONFIG_DIR_NAME,
	formatSkillsForPrompt,
	getAgentDir,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	appendSection,
	buildManagedSystemPrompt,
	replaceAvailableToolsInPrompt,
	replacePiPromptPrefix,
	type ToolPromptSpec,
} from "./system-prompt-core.ts";
import { detectEnvironment } from "./system-prompt-env.ts";

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

interface EffectiveConfig {
	basePrompt?: string;
	general: string[];
	tools: Record<string, ToolPromptSpec>;
	errors: string[];
	absent: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfig(path: string): ConfigReadResult {
	if (!existsSync(path)) return {};

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
		if (general !== undefined && (!Array.isArray(general) || general.some((item) => typeof item !== "string"))) {
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

function loadConfig(cwd: string, trusted: boolean): EffectiveConfig {
	const globalPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const globalResult = readConfig(globalPath);
	const projectPath = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
	const projectResult = trusted ? readConfig(projectPath) : { absent: true };

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

export function buildPiSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd: rawCwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const cwd = rawCwd.replace(/\\/g, "/");
	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;
		if (appendSection) prompt += appendSection;
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path, content } of contextFiles) {
				prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) prompt += formatSkillsForPrompt(skills);
		prompt += `\nCurrent working directory: ${cwd}`;
		return prompt;
	}

	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const snippets = toolSnippets ?? {};
	const visibleTools = tools.filter((name) => !!snippets[name]);
	const toolsList = visibleTools.length > 0
		? visibleTools.map((name) => `- ${name}: ${snippets[name]}`).join("\n")
		: "(none)";
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string) => {
		if (!guidelinesSet.has(guideline)) {
			guidelinesSet.add(guideline);
			guidelinesList.push(guideline);
		}
	};
	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}
	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized) addGuideline(normalized);
	}
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");
	const guidelines = guidelinesList.map((guideline) => `- ${guideline}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n${toolsList}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n${guidelines}\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: ${readmePath}\n- Additional docs: ${docsPath}\n- Examples: ${examplesPath} (extensions, custom tools, SDK)\n- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory\n- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)\n- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing\n- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
	if (appendSection) prompt += appendSection;
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path, content } of contextFiles) {
			prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}
	if (hasRead && skills.length > 0) prompt += formatSkillsForPrompt(skills);
	prompt += `\nCurrent working directory: ${cwd}`;
	return prompt;
}

const warnedConfigErrors = new Set<string>();

export default function systemPromptExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		for (const error of config.errors) {
			if (!warnedConfigErrors.has(error)) {
				warnedConfigErrors.add(error);
				ctx.ui.notify(`System prompt config ignored: ${error}`, "warning");
			}
		}

		if (!config.basePrompt) {
			if (Object.keys(config.tools).length === 0 && config.general.length === 0) return undefined;
			return {
				systemPrompt: replaceAvailableToolsInPrompt(
					event.systemPrompt,
					event.systemPromptOptions,
					config.tools,
					config.general,
					false,
				),
			};
		}

		const managedPrompt = buildManagedSystemPrompt(
			config.basePrompt,
			event.systemPromptOptions,
			config.tools,
			config.general,
			detectEnvironment(ctx.cwd),
			getAgentDir(),
			(skills) => formatSkillsForPrompt(skills as NonNullable<BuildSystemPromptOptions["skills"]>),
		);
		const piPrompt = buildPiSystemPrompt(event.systemPromptOptions);
		const prompt = replacePiPromptPrefix(event.systemPrompt, piPrompt, managedPrompt);
		if (prompt !== undefined) return { systemPrompt: prompt };

		// A replacement-style extension has no composable boundary. Keep it intact
		// and append the configured prompt so its instructions are not discarded.
		return {
			systemPrompt: appendSection(
				event.systemPrompt,
				`Configured base prompt:\n${managedPrompt}`,
			),
		};
	});
}
