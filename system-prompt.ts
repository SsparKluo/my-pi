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
import {
	appendSection,
	buildManagedSystemPrompt,
	replaceAvailableToolsInPrompt,
	replacePiPromptPrefix,
} from "./system-prompt-core.ts";
import { type EffectiveConfig, loadConfig } from "./system-prompt-config.ts";
import { detectEnvironment } from "./system-prompt-env.ts";

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
const warnedPrefixDrift = { current: false };

export default function systemPromptExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const config = loadConfig({
			cwd: ctx.cwd,
			trusted: ctx.isProjectTrusted(),
			agentDir: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
		});

		// No config at all: leave Pi's prompt completely untouched.
		if (config.absent) return undefined;

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

		// Drift: our reconstructed Pi prompt no longer matches the real upstream
		// output (Pi upgraded its prompt format). We can't cleanly isolate Pi's
		// prefix, so keep the incoming prompt intact and append ours. Warn once so
		// the operator knows to refresh the buildPiSystemPrompt copy.
		if (!warnedPrefixDrift.current) {
			warnedPrefixDrift.current = true;
			ctx.ui.notify(
				"system-prompt extension: Pi base prompt format changed upstream; falling back to append mode. Update the buildPiSystemPrompt copy.",
				"warning",
			);
		}
		return {
			systemPrompt: appendSection(
				event.systemPrompt,
				`Configured base prompt:\n${managedPrompt}`,
			),
		};
	});
}
