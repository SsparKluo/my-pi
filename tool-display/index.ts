/**
 * tool-display — compact, configurable rendering overrides for pi's built-in tools.
 *
 * Structure adapted from @siddr/pi-tool-display (index.ts) — MIT, https://github.com/sids/pi-extensions
 * Differences: global config drive (~/.pi/agent/tool-display.json), adaptive single/dual-column
 * edit diffs with inline word-diff (see ./diff.ts), full bash-command reveal on Ctrl+O expand,
 * and compact renderers for @ff-labs/pi-fff's fffind/ffgrep (injected via getAllRegisteredTools patch).
 * User-message rendering is intentionally untouched.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { renderDiff } from "./diff.ts";
import { DEFAULT_CONFIG, loadConfig, type ToolDisplayConfig, type ToolName } from "./config.ts";
import {
	buildPreview,
	countFffFindResults,
	countFffGrepMatches,
	countFindResults,
	countGrepMatches,
	countLines,
	countLsEntries,
	countReadLines,
	extractTextContent,
	formatDisplayPath,
	hasImageContent,
	isErrorResult,
	splitTrailingNoticeBlock,
} from "./utils.ts";

type BuiltInTools = ReturnType<typeof createBuiltInTools>;
type Theme = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"]>>[1];

const toolCache = new Map<string, BuiltInTools>();

function createBuiltInTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
		edit: createEditTool(cwd),
		bash: createBashTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	};
}

function getBuiltInTools(cwd: string): BuiltInTools {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

function text(text: string): Component {
	return new Text(text, 0, 0);
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

function formatLineCount(count: number): string {
	return `${count} ${pluralize(count, "line")}`;
}

function editorHint(description: string, theme: Theme): string {
	return `${theme.fg("dim", "ctrl+o")}${theme.fg("muted", ` ${description}`)}`;
}

function expandHint(theme: Theme): string {
	return `(${editorHint("to expand", theme)})`;
}

function remainingLinesHint(remainingLines: number, theme: Theme): string {
	return `${theme.fg("muted", `... (${remainingLines} more ${pluralize(remainingLines, "line")}, `)}${editorHint("to expand", theme)}${theme.fg("muted", ")")}`;
}

function fullOutputHint(skippedLines: number, theme: Theme): string {
	return `${theme.fg("muted", `... (${skippedLines} earlier ${pluralize(skippedLines, "visual line")}). Press `)}${theme.fg("dim", "ctrl+o")}${theme.fg("muted", " to see the full output.")}`;
}

function warningLine(notice: string | undefined, theme: Theme): string | undefined {
	return notice ? theme.fg("dim", notice) : undefined;
}

function joinSections(...parts: Array<string | undefined>): string {
	return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
}

function renderRawText(value: string, theme: Theme, isError: boolean): Component {
	const output = value.length > 0 ? value : isError ? "Error" : "(no output)";
	return text(isError ? theme.fg("error", output) : output);
}

function renderVisualTail(
	output: string,
	prefix: string | undefined,
	suffix: string | undefined,
	theme: Theme,
	previewLines: number,
): Component {
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(width, 1);
			const outputLines = new Text(output, 0, 0).render(safeWidth);
			const skippedLines = Math.max(outputLines.length - previewLines, 0);
			const lines: string[] = [];
			if (prefix) {
				lines.push(...new Text(prefix, 0, 0).render(safeWidth));
			}
			if (skippedLines > 0) {
				lines.push(...new Text(fullOutputHint(skippedLines, theme), 0, 0).render(safeWidth));
			}
			lines.push(...outputLines.slice(-previewLines));
			if (suffix) {
				lines.push(...new Text(suffix, 0, 0).render(safeWidth));
			}
			return lines;
		},
		invalidate() {},
	};
}

type BashRenderState = {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
};

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local wall-clock timestamp, second precision: yyyy-mm-dd hh:mm:ss */
function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Track bash start/end on renderer state; return a muted timing line when known. */
function bashTimingLine(
	state: BashRenderState,
	isPartial: boolean,
	executionStarted: boolean,
	invalidate: () => void,
	theme: Theme,
): string | undefined {
	if (executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
	if (state.startedAt === undefined) {
		return undefined;
	}
	if (isPartial && state.interval === undefined) {
		state.interval = setInterval(() => invalidate(), 1000);
	}
	if (!isPartial) {
		state.endedAt ??= Date.now();
		if (state.interval !== undefined) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}
	const end = state.endedAt ?? Date.now();
	const duration = formatDuration(end - state.startedAt);
	const when = formatTimestamp(state.startedAt);
	const label = isPartial ? "elapsed" : "took";
	return theme.fg("muted", `↳ ${label} ${duration} · ${when}`);
}

/** Expanded bash view: full command (wrapped) above, full output below. */
function renderExpandedBash(
	command: string,
	output: string,
	status: string | undefined,
	warning: string | undefined,
	timing: string | undefined,
	theme: Theme,
): Component {
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(width, 1);
			const lines: string[] = [];
			if (status) {
				lines.push(...new Text(status, 0, 0).render(safeWidth));
			}
			if (command.length > 0) {
				lines.push(theme.fg("dim", "command"));
				const commandStyled = `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", command)}`;
				lines.push(...new Text(commandStyled, 0, 0).render(safeWidth));
			}
			if (output.length > 0) {
				if (command.length > 0) {
					lines.push(theme.fg("dim", "output"));
				}
				lines.push(...new Text(output, 0, 0).render(safeWidth));
			} else if (!status) {
				lines.push(theme.fg("muted", "↳ (no output)"));
			}
			if (warning) {
				lines.push(...new Text(warning, 0, 0).render(safeWidth));
			}
			if (timing) {
				lines.push(...new Text(timing, 0, 0).render(safeWidth));
			}
			return lines;
		},
		invalidate() {},
	};
}

type ToolPromptMetadata = {
	promptGuidelines?: string[];
};

function getToolPromptMetadata(pi: ExtensionAPI, toolName: string): ToolPromptMetadata {
	const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
	const meta: ToolPromptMetadata = {};
	if (tool?.promptGuidelines) {
		meta.promptGuidelines = [...tool.promptGuidelines];
	}
	return meta;
}

function getEditPrepareArguments(tool: BuiltInTools["edit"] | undefined) {
	const prepareArguments = tool?.prepareArguments;
	return typeof prepareArguments === "function" ? prepareArguments : undefined;
}

function registerOverrides(pi: ExtensionAPI, cwd: string, config: ToolDisplayConfig) {
	const referenceTools = getBuiltInTools(cwd);
	const editPrepareArguments = getEditPrepareArguments(referenceTools.edit);

	if (config.enabled.read) {
		pi.registerTool({
			name: "read",
			label: "read",
			description: referenceTools.read.description,
			...getToolPromptMetadata(pi, "read"),
			parameters: referenceTools.read.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme) {
				const displayPath = formatDisplayPath(args.path ?? "", {
					offset: typeof args.offset === "number" ? args.offset : undefined,
					limit: typeof args.limit === "number" ? args.limit : undefined,
				});
				return text(`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", displayPath)}`);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					return text(theme.fg("muted", "↳ loading..."));
				}
				const resultText = extractTextContent(result);
				if (isErrorResult(result, resultText)) {
					return renderRawText(resultText, theme, true);
				}
				if (hasImageContent(result)) {
					return renderRawText(resultText || "Read image file", theme, false);
				}
				const { body } = splitTrailingNoticeBlock(resultText);
				if (!expanded) {
					if (config.readPreviewLines > 0) {
						const preview = buildPreview(body, config.readPreviewLines);
						const display = theme.fg("dim", preview.previewText);
						const hint = preview.hasMore ? remainingLinesHint(preview.remainingLines, theme) : undefined;
						return text(joinSections(display, hint));
					}
					const lineCount = countReadLines(resultText);
					const summary = `${theme.fg("muted", `↳ loaded ${formatLineCount(lineCount)}`)} ${expandHint(theme)}`;
					return text(joinSections(summary));
				}
				const languageHint = body.length > 0 ? body : theme.fg("muted", "(empty file)");
				return text(joinSections(languageHint));
			},
		});
	}

	if (config.enabled.write) {
		pi.registerTool({
			name: "write",
			label: "write",
			description: referenceTools.write.description,
			...getToolPromptMetadata(pi, "write"),
			parameters: referenceTools.write.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme) {
				const displayPath = formatDisplayPath(args.path ?? "");
				const lineCount = countLines(args.content ?? "");
				return text(`${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", displayPath)} ${theme.fg("muted", `(${formatLineCount(lineCount)})`)}`);
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) {
					return text(theme.fg("muted", "Writing..."));
				}
				const resultText = extractTextContent(result);
				if (isErrorResult(result, resultText)) {
					return renderRawText(resultText, theme, true);
				}
				const content = typeof context.args?.content === "string" ? context.args.content : "";
				const lineCount = countLines(content);
				if (!expanded) {
					const summary = `${theme.fg("muted", `↳ wrote ${formatLineCount(lineCount)}`)} ${expandHint(theme)}`;
					return text(summary);
				}
				const display = content.length > 0 ? theme.fg("dim", content) : theme.fg("muted", "(empty file)");
				return text(display);
			},
		});
	}

	if (config.enabled.bash) {
		pi.registerTool({
			name: "bash",
			label: "bash",
			description: referenceTools.bash.description,
			...getToolPromptMetadata(pi, "bash"),
			parameters: referenceTools.bash.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme) {
				let value = `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", args.command ?? "")}`;
				if (typeof args.timeout === "number") {
					value += ` ${theme.fg("muted", `(timeout ${args.timeout}s)`)}`;
				}
				return text(value);
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				const resultText = extractTextContent(result);
				const isError = isErrorResult(result, resultText);
				const command = typeof context.args?.command === "string" ? context.args.command : "";
				const state = context.state as BashRenderState;
				const timing = bashTimingLine(state, isPartial, context.executionStarted, context.invalidate, theme);

				if (isError) {
					const output = resultText.trim();
					const prefix = theme.fg("error", "↳ command failed");
					if (!expanded && output.length > 0) {
						return renderVisualTail(theme.fg("error", output), prefix, timing, theme, config.bashPreviewLines);
					}
					return text(joinSections(prefix, output.length > 0 ? theme.fg("error", output) : undefined, timing));
				}

				const { body, notice } = splitTrailingNoticeBlock(resultText);
				const previewSource = (body.length > 0 ? body : resultText).trim();
				const status = isPartial ? theme.fg("warning", "running...") : undefined;
				const warning = warningLine(notice, theme);

				if (!expanded && previewSource.length > 0) {
					return renderVisualTail(theme.fg("dim", previewSource), status, joinSections(warning, timing), theme, config.bashPreviewLines);
				}

				if (expanded) {
					return renderExpandedBash(command, previewSource, status, warning, timing, theme);
				}

				const display = previewSource.length > 0
					? theme.fg("dim", previewSource)
					: !isPartial ? theme.fg("muted", "↳ (no output)") : undefined;
				return text(joinSections(status, display, warning, timing));
			},
		});
	}

	if (config.enabled.edit) {
		pi.registerTool({
			name: "edit",
			label: "edit",
			description: referenceTools.edit.description,
			renderShell: "default",
			...getToolPromptMetadata(pi, "edit"),
			parameters: referenceTools.edit.parameters,
			...(editPrepareArguments ? { prepareArguments: editPrepareArguments } : {}),
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme) {
				const displayPath = formatDisplayPath(args.path ?? "");
				const edits = Array.isArray(args.edits) ? args.edits.length : 0;
				const suffix = edits > 0 ? ` ${theme.fg("muted", `(${edits} ${pluralize(edits, "block")})`)}` : "";
				return text(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", displayPath)}${suffix}`);
			},
			renderResult(result, { isPartial }, theme, context) {
				if (isPartial) {
					return text(theme.fg("muted", "Editing..."));
				}
				const resultText = extractTextContent(result);
				if (context.isError || isErrorResult(result, resultText)) {
					return renderRawText(resultText, theme, true);
				}
				const details = (result as { details?: { diff?: unknown } }).details;
				const diff = typeof details?.diff === "string" ? details.diff : "";
				if (!diff) {
					return text(theme.fg("success", "Applied"));
				}
				const filePath = typeof context.args?.path === "string" ? context.args.path : undefined;
				return renderDiff(
					diff,
					{
						filePath,
						mode: config.diffMode,
						columnWidth: config.diffColumnWidth,
						syntaxHighlight: config.diffSyntaxHighlight,
					},
					theme,
				);
			},
		});
	}

	if (config.enabled.grep) {
		pi.registerTool({
			name: "grep",
			label: "grep",
			description: referenceTools.grep.description,
			...getToolPromptMetadata(pi, "grep"),
			parameters: referenceTools.grep.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme) {
				let value = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", args.literal ? JSON.stringify(args.pattern ?? "") : `/${args.pattern ?? ""}/`)}`;
				value += theme.fg("muted", ` in ${formatDisplayPath(args.path ?? ".")}`);
				if (args.glob) {
					value += ` ${theme.fg("dim", `(${args.glob})`)}`;
				}
				return text(value);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					return text(theme.fg("muted", "Searching..."));
				}
				const resultText = extractTextContent(result);
				if (isErrorResult(result, resultText)) {
					return renderRawText(resultText, theme, true);
				}
				const { body, notice } = splitTrailingNoticeBlock(resultText);
				if (expanded) {
					return text(joinSections(body || resultText || theme.fg("muted", "(no matches)"), warningLine(notice, theme)));
				}
				const count = countGrepMatches(resultText);
				const summary = `${theme.fg("muted", `↳ ${count} ${pluralize(count, "match")}`)} ${expandHint(theme)}`;
				return text(joinSections(summary, warningLine(notice, theme)));
			},
		});
	}

	if (config.enabled.find) {
		pi.registerTool({
			name: "find",
			label: "find",
			description: referenceTools.find.description,
			...getToolPromptMetadata(pi, "find"),
			parameters: referenceTools.find.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme) {
				let value = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern ?? "")}`;
				value += theme.fg("muted", ` in ${formatDisplayPath(args.path ?? ".")}`);
				if (typeof args.limit === "number") {
					value += ` ${theme.fg("dim", `(limit ${args.limit})`)}`;
				}
				return text(value);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					return text(theme.fg("muted", "Searching..."));
				}
				const resultText = extractTextContent(result);
				if (isErrorResult(result, resultText)) {
					return renderRawText(resultText, theme, true);
				}
				const { body, notice } = splitTrailingNoticeBlock(resultText);
				if (expanded) {
					return text(joinSections(body || resultText || theme.fg("muted", "(no files)"), warningLine(notice, theme)));
				}
				const count = countFindResults(resultText);
				const summary = `${theme.fg("muted", `↳ ${count} ${pluralize(count, "file")}`)} ${expandHint(theme)}`;
				return text(joinSections(summary, warningLine(notice, theme)));
			},
		});
	}

	if (config.enabled.ls) {
		pi.registerTool({
			name: "ls",
			label: "ls",
			description: referenceTools.ls.description,
			...getToolPromptMetadata(pi, "ls"),
			parameters: referenceTools.ls.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme) {
				let value = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", formatDisplayPath(args.path ?? "."))}`;
				if (typeof args.limit === "number") {
					value += ` ${theme.fg("dim", `(limit ${args.limit})`)}`;
				}
				return text(value);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					return text(theme.fg("muted", "Listing..."));
				}
				const resultText = extractTextContent(result);
				if (isErrorResult(result, resultText)) {
					return renderRawText(resultText, theme, true);
				}
				const { body, notice } = splitTrailingNoticeBlock(resultText);
				if (expanded) {
					return text(joinSections(body || resultText || theme.fg("muted", "(empty directory)"), warningLine(notice, theme)));
				}
				const count = countLsEntries(resultText);
				const summary = `${theme.fg("muted", `↳ ${count} ${pluralize(count, "entry")}`)} ${expandHint(theme)}`;
				return text(joinSections(summary, warningLine(notice, theme)));
			},
		});
	}
}

// ── @ff-labs/pi-fff compact renderers ──────────────────────────────────────
//
// fffind/ffgrep are registered by another extension. Pi's tool registry is
// first-wins across extensions, so re-registering them would either be ignored
// or steal execute. Instead we patch getAllRegisteredTools to inject only our
// renderCall/renderResult onto the winning definition (execute stays original).

const FFF_TOOL_NAMES = ["ffgrep", "fffind"] as const;
type FffToolName = (typeof FFF_TOOL_NAMES)[number];

const FFF_PATCH_FLAG = Symbol.for("@ssparkluo/my-pi.tool-display.fff-patch");

/** Live config for the FFF renderer patch (updated on session_start). */
let fffDisplayConfig: ToolDisplayConfig = {
	...DEFAULT_CONFIG,
	enabled: { ...DEFAULT_CONFIG.enabled },
};

function totalMatchedFromDetails(result: { details?: unknown }): number | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null) {
		return undefined;
	}
	const value = (details as { totalMatched?: unknown }).totalMatched;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createFffGrepRenderers() {
	return {
		renderCall(args: Record<string, unknown>, theme: Theme) {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			const path = typeof args.path === "string" ? args.path : ".";
			let value = `${theme.fg("toolTitle", theme.bold("ffgrep"))} ${theme.fg("accent", `/${pattern}/`)}`;
			value += theme.fg("muted", ` in ${formatDisplayPath(path)}`);
			if (typeof args.limit === "number") {
				value += ` ${theme.fg("dim", `(limit ${args.limit})`)}`;
			}
			if (typeof args.cursor === "string" && args.cursor.length > 0) {
				value += theme.fg("muted", " (page)");
			}
			return text(value);
		},
		renderResult(
			result: { content?: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
			{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
			theme: Theme,
		) {
			if (isPartial) {
				return text(theme.fg("muted", "Searching..."));
			}
			const resultText = extractTextContent(result);
			if (isErrorResult(result, resultText)) {
				return renderRawText(resultText, theme, true);
			}
			const { body } = splitTrailingNoticeBlock(resultText);
			if (expanded) {
				return text(body || resultText || theme.fg("muted", "(no matches)"));
			}
			const count = totalMatchedFromDetails(result) ?? countFffGrepMatches(resultText);
			const summary = `${theme.fg("muted", `↳ ${count} ${pluralize(count, "match")}`)} ${expandHint(theme)}`;
			return text(summary);
		},
	};
}

function createFffFindRenderers() {
	return {
		renderCall(args: Record<string, unknown>, theme: Theme) {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			const path = typeof args.path === "string" ? args.path : ".";
			let value = `${theme.fg("toolTitle", theme.bold("fffind"))} ${theme.fg("accent", pattern)}`;
			value += theme.fg("muted", ` in ${formatDisplayPath(path)}`);
			if (typeof args.limit === "number") {
				value += ` ${theme.fg("dim", `(limit ${args.limit})`)}`;
			}
			if (typeof args.cursor === "string" && args.cursor.length > 0) {
				value += theme.fg("muted", " (page)");
			}
			return text(value);
		},
		renderResult(
			result: { content?: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
			{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
			theme: Theme,
		) {
			if (isPartial) {
				return text(theme.fg("muted", "Searching..."));
			}
			const resultText = extractTextContent(result);
			if (isErrorResult(result, resultText)) {
				return renderRawText(resultText, theme, true);
			}
			const { body } = splitTrailingNoticeBlock(resultText);
			if (expanded) {
				return text(body || resultText || theme.fg("muted", "(no files)"));
			}
			const count = totalMatchedFromDetails(result) ?? countFffFindResults(resultText);
			const summary = `${theme.fg("muted", `↳ ${count} ${pluralize(count, "file")}`)} ${expandHint(theme)}`;
			return text(summary);
		},
	};
}

const fffRenderers: Record<FffToolName, ReturnType<typeof createFffGrepRenderers>> = {
	ffgrep: createFffGrepRenderers(),
	fffind: createFffFindRenderers(),
};

function isFffToolName(name: string): name is FffToolName {
	return (FFF_TOOL_NAMES as readonly string[]).includes(name);
}

function isToolEnabled(name: ToolName): boolean {
	return fffDisplayConfig.enabled[name] !== false;
}

/**
 * Inject compact fffind/ffgrep renderers onto whatever extension owns those
 * tools (normally @ff-labs/pi-fff). Preserves the original execute.
 */
function installFffRendererPatch(): void {
	const proto = ExtensionRunner.prototype as unknown as Record<string | symbol, unknown>;
	if (proto[FFF_PATCH_FLAG]) {
		return;
	}

	const original = proto.getAllRegisteredTools as (this: ExtensionRunner) => Array<{
		definition: {
			name?: string;
			renderCall?: unknown;
			renderResult?: unknown;
		};
	}>;
	proto.getAllRegisteredTools = function patchedGetAllRegisteredTools(this: ExtensionRunner) {
		const tools = original.call(this);
		for (const tool of tools) {
			const name = tool.definition.name;
			if (typeof name !== "string" || !isFffToolName(name) || !isToolEnabled(name)) {
				continue;
			}
			const renderer = fffRenderers[name];
			tool.definition.renderCall = renderer.renderCall;
			tool.definition.renderResult = renderer.renderResult;
		}
		return tools;
	};
	proto[FFF_PATCH_FLAG] = true;
}

// Install as early as this extension loads so the first registry build is patched.
installFffRendererPatch();

export default function (pi: ExtensionAPI) {
	let registered = false;

	pi.on("session_start", (_event, ctx) => {
		if (registered) {
			return;
		}
		const { config, errors } = loadConfig();
		if (errors.length > 0) {
			// Surface config problems without blocking startup; invalid fields fall back to defaults.
			console.error(`[tool-display] config errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
		}
		fffDisplayConfig = config;
		const activeTools = pi.getActiveTools();
		registerOverrides(pi, ctx.cwd, config);
		// registerOverrides triggers refreshTools, which re-runs the FFF renderer patch with live config.
		pi.setActiveTools(activeTools);
		registered = true;
	});
}
