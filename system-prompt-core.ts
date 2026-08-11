export interface PromptContextFile {
	path: string;
	content: string;
}

export interface EnvironmentInfo {
	cwd: string;
	worktree: string;
	isGitRepo: boolean;
	platform: NodeJS.Platform;
}

export interface ToolPromptSpec {
	snippet: string;
	guidelines: readonly string[];
}

export interface ManagedSystemPromptOptions<S = unknown> {
	cwd: string;
	appendSystemPrompt?: string;
	contextFiles?: readonly PromptContextFile[];
	promptGuidelines?: readonly string[];
	selectedTools?: readonly string[];
	toolSnippets?: Readonly<Record<string, string>>;
	skills?: S[];
}

export type SkillPromptFormatter<S = unknown> = (skills: S[]) => string;

export interface BuildManagedPromptOptions<S = unknown> {
	basePrompt: string;
	/** The prompt options we are rebuilding from (Pi's systemPromptOptions). */
	options: ManagedSystemPromptOptions<S>;
	configuredTools: Readonly<Record<string, ToolPromptSpec>>;
	generalGuidelines: readonly string[];
	environment: EnvironmentInfo;
	agentDir: string;
	formatSkills: SkillPromptFormatter<S>;
}

export function uniqueGuidelines(guidelines: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const guideline of guidelines) {
		const normalized = guideline.trim();
		if (normalized && !seen.has(normalized)) {
			seen.add(normalized);
			result.push(normalized);
		}
	}
	return result;
}

export function appendSection(prompt: string, section: string): string {
	const normalized = section.trim();
	return normalized ? `${prompt.trimEnd()}\n\n${normalized}` : prompt;
}

export function formatInstructionFiles(
	contextFiles: readonly PromptContextFile[] | undefined,
	agentDir: string,
): string {
	if (!contextFiles || contextFiles.length === 0) return "";

	const global: PromptContextFile[] = [];
	const project: PromptContextFile[] = [];
	const agentRoot = resolveInstructionRoot(agentDir);
	for (const file of contextFiles) {
		if (isInside(file.path, agentRoot)) global.push(file);
		else project.push(file);
	}

	const parts: string[] = [];
	if (global.length > 0) parts.push(formatInstructionBlock("global_instruction", global));
	if (project.length > 0) parts.push(formatInstructionBlock("project_instruction", project));
	return parts.join("\n\n");
}

function resolveInstructionRoot(agentDir: string): string {
	return agentDir.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isInside(filePath: string, root: string): boolean {
	if (!root) return false;
	const normalized = filePath.replace(/\\/g, "/");
	return normalized === root || normalized.startsWith(`${root}/`);
}

function formatInstructionBlock(tag: "global_instruction" | "project_instruction", files: readonly PromptContextFile[]): string {
	const lines: string[] = [`<${tag}>`];
	for (const { path, content } of files) {
		lines.push(`<instruction path="${path}">`);
		lines.push(content.trimEnd());
		lines.push("</instruction>");
	}
	lines.push(`</${tag}>`);
	return lines.join("\n");
}

export function formatToolPrompts(
	options: ManagedSystemPromptOptions,
	configuredTools: Readonly<Record<string, ToolPromptSpec>>,
): string {
	const tools = options.selectedTools ?? ["read", "bash", "edit", "write"];
	const snippets = options.toolSnippets ?? {};
	const lines: string[] = [];

	for (const name of tools) {
		const configuredTool = configuredTools[name];
		const snippet = configuredTool?.snippet ?? snippets[name];
		if (!snippet) continue;

		lines.push(`- ${name}: ${snippet.trim()}`);
		for (const guideline of uniqueGuidelines(configuredTool?.guidelines ?? [])) {
			lines.push(`  - ${guideline}`);
		}
	}

	if (lines.length === 0) return "";

	return [
		"<tool_use>",
		...lines,
		"",
		"In addition to the tools above, you may have access to other custom tools depending on the project.",
		"</tool_use>",
	].join("\n");
}

export function formatGeneralGuidelines(generalGuidelines: readonly string[]): string {
	const guidelines = uniqueGuidelines(generalGuidelines);
	if (guidelines.length === 0) return "";
	return ["<general_guidelines>", ...guidelines.map((guideline) => `- ${guideline}`), "</general_guidelines>"].join("\n");
}

export function buildManagedSystemPrompt<S = unknown>(opts: BuildManagedPromptOptions<S>): string {
	const { basePrompt, options, configuredTools, generalGuidelines, environment, agentDir, formatSkills } = opts;
	let prompt = basePrompt;

	prompt = appendSection(prompt, formatGeneralGuidelines(generalGuidelines));
	prompt = appendSection(prompt, formatToolPrompts(options, configuredTools));

	const appendSystemPrompt = options.appendSystemPrompt?.trim();
	if (appendSystemPrompt) prompt = appendSection(prompt, appendSystemPrompt);

	prompt = appendSection(prompt, formatEnvironment(environment));
	prompt = appendSection(prompt, formatInstructionFiles(options.contextFiles, agentDir));

	const hasReadTool = options.selectedTools?.includes("read") ?? true;
	if (hasReadTool && options.skills && options.skills.length > 0) {
		prompt = appendSection(prompt, formatSkills(options.skills));
	}

	return prompt;
}

export function formatEnvironment(env: EnvironmentInfo): string {
	return [
		"<env>",
		`  Working directory: ${env.cwd.replace(/\\/g, "/")}`,
		`  Workspace root folder: ${env.worktree.replace(/\\/g, "/")}`,
		`  Is directory a git repo: ${env.isGitRepo ? "yes" : "no"}`,
		`  Platform: ${env.platform}`,
		"</env>",
	].join("\n");
}

function findTagBlock(prompt: string, tag: string): { start: number; end: number } | undefined {
	const openTag = `<${tag}>`;
	const closeTag = `</${tag}>`;
	const open = prompt.indexOf(openTag);
	if (open === -1) return undefined;
	const openStart = open > 0 && prompt[open - 1] === "\n" ? open - 1 : open;
	const contentStart = open + openTag.length;
	const end = prompt.indexOf(closeTag, contentStart);
	if (end === -1) return undefined;
	const endEnd = end + closeTag.length;
	const trailing = prompt.indexOf("\n", endEnd);
	const endOfBlock = trailing === endEnd + 1 ? trailing + 1 : endEnd;
	return { start: openStart, end: endOfBlock };
}

function replaceTagBlock(prompt: string, tag: string, replacement: string): string | undefined {
	const block = findTagBlock(prompt, tag);
	if (!block) return undefined;
	const normalized = replacement.trim();
	if (!normalized) {
		return `${prompt.slice(0, block.start)}${prompt.slice(block.end)}`;
	}
	return `${prompt.slice(0, block.start)}\n\n${normalized}${prompt.slice(block.end)}`;
}

/** Replace Pi's base prefix while preserving extension suffixes. */
export function replacePiPromptPrefix(
	currentPrompt: string,
	piPrompt: string,
	managedPrompt: string,
): string | undefined {
	if (currentPrompt === piPrompt) return managedPrompt;
	if (currentPrompt.startsWith(piPrompt)) {
		return managedPrompt + currentPrompt.slice(piPrompt.length);
	}
	return undefined;
}

/** Replace Pi's available-tools block without touching the rest of the prompt. */
export function replaceAvailableToolsInPrompt(
	prompt: string,
	options: ManagedSystemPromptOptions,
	configuredTools: Readonly<Record<string, ToolPromptSpec>>,
	generalGuidelines: readonly string[],
	stripPiDefaults: boolean,
): string {
	const toolsSection = formatToolPrompts(options, configuredTools);
	const generalSection = formatGeneralGuidelines(generalGuidelines);

	if (!toolsSection && !generalSection) return prompt;

	let result = prompt;
	if (toolsSection) {
		const startMarker = "\n\nAvailable tools:\n";
		const endMarker = "\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.";
		const start = result.indexOf(startMarker);
		const end = start === -1 ? -1 : result.indexOf(endMarker, start + startMarker.length);
		if (start !== -1 && end !== -1) {
			const withoutOriginalAvailableHeader = start > 0 ? result.slice(0, start) + result.slice(end + endMarker.length) : result.slice(end + endMarker.length);
			result = appendSection(withoutOriginalAvailableHeader, toolsSection);
		} else {
			result = appendSection(result, toolsSection);
		}
	}
	const replaced = replaceTagBlock(result, "general_guidelines", generalSection);
	result = replaced ?? (generalSection ? appendSection(result, generalSection) : result);
	return stripPiDefaults ? stripPiDefaultGuidelines(result) : result;
}

function stripPiDefaultGuidelines(prompt: string): string {
	const header = "\n\nGuidelines:\n";
	const start = prompt.indexOf(header);
	if (start === -1) return prompt;
	const afterGuidelines = prompt.indexOf("\n\n", start + header.length);
	return afterGuidelines === -1 ? prompt.slice(0, start) : `${prompt.slice(0, start)}${prompt.slice(afterGuidelines)}`;
}
