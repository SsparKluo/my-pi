export interface EnvironmentInfo {
	worktree: string;
	isGitRepo: boolean;
	platform: NodeJS.Platform;
}

export interface ToolPromptSpec {
	/** One-line tool description override. Only feeds Pi's native <tools> list (no-basePrompt path). */
	snippet?: string;
	guidelines: readonly string[];
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

/** <tool_use> section content: one `- <tool>: <guideline>` line per guideline, in tool-loadout order. */
export function formatToolGuidelines(
	selectedTools: readonly string[],
	configuredTools: Readonly<Record<string, ToolPromptSpec>>,
): string {
	const lines: string[] = [];
	for (const name of selectedTools) {
		for (const guideline of uniqueGuidelines(configuredTools[name]?.guidelines ?? [])) {
			lines.push(`- ${name}: ${guideline}`);
		}
	}
	return lines.join("\n");
}

/** <general_guidelines> section content: general guideline bullets. */
export function formatGeneralGuidelines(generalGuidelines: readonly string[]): string {
	return uniqueGuidelines(generalGuidelines)
		.map((guideline) => `- ${guideline}`)
		.join("\n");
}

/** <env> section content; cwd itself lives in Pi's native <cwd> section. */
export function formatEnvironment(env: EnvironmentInfo): string {
	return [
		`Workspace root folder: ${env.worktree.replace(/\\/g, "/")}`,
		`Is directory a git repo: ${env.isGitRepo ? "yes" : "no"}`,
		`Platform: ${env.platform}`,
	].join("\n");
}

function wrapSection(name: string, content: string): string {
	const body = content.trim();
	if (!body) return "";
	return `<${name}>\n${body}\n</${name}>`;
}

/** Magic Context / other ctx_* tools. */
export function hasContextTools(selectedTools: readonly string[]): boolean {
	return selectedTools.some((name) => name.startsWith("ctx_"));
}

/**
 * Fold configured guidelines into the preamble so they render ABOVE Pi's native
 * `<project_context>` / `<skills>` / `<cwd>`. Custom `options.sections` are
 * appended after those native sections, which buried the managed prompt.
 */
export function composeManagedPreamble(args: {
	basePrompt: string;
	general: readonly string[];
	contextManagement?: readonly string[];
	selectedTools: readonly string[];
	configuredTools: Readonly<Record<string, ToolPromptSpec>>;
	env: EnvironmentInfo;
}): string {
	const parts = [args.basePrompt.trim()];
	const general = wrapSection("general_guidelines", formatGeneralGuidelines(args.general));
	if (general) parts.push(general);
	const contextManagement =
		hasContextTools(args.selectedTools) && (args.contextManagement?.length ?? 0) > 0
			? wrapSection("context_management", formatGeneralGuidelines(args.contextManagement ?? []))
			: "";
	if (contextManagement) parts.push(contextManagement);
	const tools = wrapSection("tool_use", formatToolGuidelines(args.selectedTools, args.configuredTools));
	if (tools) parts.push(tools);
	parts.push(wrapSection("env", formatEnvironment(args.env)));
	return parts.join("\n\n");
}
