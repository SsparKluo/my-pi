import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	GLUE_TOOL_NAME,
	hiddenDeclarations,
	loadToolLoadoutConfig,
} from "./tool-loadout-config.ts";

export default function toolLoadoutExtension(pi: ExtensionAPI) {
	const loaded = loadToolLoadoutConfig(getAgentDir());
	if (loaded.error) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(`Tool loadout config ignored: ${loaded.error}`, "warning");
		});
	}

	const hide = loaded.hide;
	const hidden = new Set(hide);

	pi.registerTool({
		name: GLUE_TOOL_NAME,
		label: "Tool loadout",
		description: "Internal loadout glue. Not for model use.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "This tool is not callable." }],
				details: undefined,
			};
		},
		prepareLoadout(loadout) {
			return {
				hiddenDeclarations: hiddenDeclarations(
					hide,
					loadout.declared.map((tool) => tool.name),
				),
			};
		},
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === GLUE_TOOL_NAME || hidden.has(event.toolName)) {
			return { block: true, reason: `${event.toolName} is not available` };
		}
		return undefined;
	});
}
