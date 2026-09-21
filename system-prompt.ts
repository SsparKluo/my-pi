import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	formatEnvironment,
	formatGeneralGuidelines,
	formatToolGuidelines,
} from "./system-prompt-core.ts";
import { loadConfig } from "./system-prompt-config.ts";
import { detectEnvironment } from "./system-prompt-env.ts";

const warnedConfigErrors = new Set<string>();

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

		const options = event.systemPromptOptions;

		// Without basePrompt, compose into Pi's native <tools>/<rules> sections.
		if (!config.basePrompt) {
			for (const [name, spec] of Object.entries(config.tools)) {
				if (spec.snippet) options.toolSnippets[name] = spec.snippet;
				const existing = options.toolGuidelines[name] ?? [];
				options.toolGuidelines[name] = [...existing, ...spec.guidelines];
			}
			options.promptGuidelines = [...options.promptGuidelines, ...config.general];
			return undefined;
		}

		// basePrompt replaces Pi's preamble. customPrompt natively suppresses Pi's
		// <tools>/<rules>/<docs>; AGENTS.md, skills, and cwd still render natively,
		// and the configured overrides ride along as custom sections.
		options.customPrompt = config.basePrompt;
		options.sections = {
			...options.sections,
			general_guidelines: formatGeneralGuidelines(config.general),
			tool_use: formatToolGuidelines(options.selectedTools, config.tools),
			env: formatEnvironment(detectEnvironment(ctx.cwd)),
		};
		return undefined;
	});
}
