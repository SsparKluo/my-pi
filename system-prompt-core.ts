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
