import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { composeManagedPreamble, formatGeneralGuidelines, hasContextTools } from "./system-prompt-core.ts";
import { loadConfig } from "./system-prompt-config.ts";
import { detectEnvironment } from "./system-prompt-env.ts";

const warnedConfigErrors = new Set<string>();

export default function systemPromptExtension(pi: ExtensionAPI) {
	// Returning { systemPrompt } (the forced-prompt path) matters: system-prompt
	// injectors such as pi-magic-context stamp their own forced prompt, and the
	// renderer short-circuits to forceSystemPrompt — mutations alone would never
	// reach the request. We clear any stale force, mutate, then re-assert our
	// render as the final forced text (later handlers' returns win in the runner).
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

		// A previous before_agent_start handler (e.g. pi-magic-context) may already
		// have stamped a forced prompt rendered from the pre-mutation options. The
		// renderer short-circuits to forceSystemPrompt, which would mask every
		// mutation below; clear it so this handler's composition is what renders.
		delete (options as { forceSystemPrompt?: string }).forceSystemPrompt;

		// Without basePrompt, compose into Pi's native <tools>/<rules> sections.
		if (!config.basePrompt) {
			for (const [name, spec] of Object.entries(config.tools)) {
				if (spec.snippet) options.toolSnippets[name] = spec.snippet;
				const existing = options.toolGuidelines[name] ?? [];
				options.toolGuidelines[name] = [...existing, ...spec.guidelines];
			}
			options.promptGuidelines = [...options.promptGuidelines, ...config.general];
			if (hasContextTools(options.selectedTools) && config.contextManagement.length > 0) {
				options.sections = {
					...options.sections,
					context_management: formatGeneralGuidelines(config.contextManagement),
				};
			}
			return { systemPrompt: event.systemPrompt };
		}

		// Fold guidelines into customPrompt (the preamble) so they sit ABOVE Pi's
		// native project_context/skills/cwd. options.sections always render after
		// those, which buried the managed prompt at the bottom of the system message.
		options.customPrompt = composeManagedPreamble({
			basePrompt: config.basePrompt,
			general: config.general,
			contextManagement: config.contextManagement,
			selectedTools: options.selectedTools,
			configuredTools: config.tools,
			env: detectEnvironment(ctx.cwd),
		});
		return { systemPrompt: event.systemPrompt };
	});
}
