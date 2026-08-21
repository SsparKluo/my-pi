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
import { ALL_TOOL_NAMES, loadConfig, type ToolDisplayConfig, type ToolName } from "./config.ts";
import {
	countFffFindResults,
	countFffGrepMatches,
	countFindResults,
	countGrepMatches,
	countLines,
	countLsEntries,
	extractTextContent,
	formatDisplayPath,
	getDiffStats,
	isErrorResult,
	splitTrailingNoticeBlock,
} from "./utils.ts";
import { formatBashTimingLine, isRtkRewrite } from "./rtk-rewrite.ts";

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

function empty(): Component {
	return {
		render() {
			return [];
		},
		invalidate() {},
	};
}

type CallChrome = {
	isError?: boolean;
	isPartial?: boolean;
};

/** Left pad before `●` on call lines. From config.paddingX. */
let toolBlockPad = " ";
/** Hang result lines under the call title (after `{pad}● `). */
let toolResultPad = "   ";
/** Pre-computed widths (avoid visibleWidth per render). */
let toolBlockPadCols = 1;
let toolResultPadCols = 3;

function applyChromeConfig(config: ToolDisplayConfig): void {
	const pad = Math.max(0, config.paddingX);
	toolBlockPad = " ".repeat(pad);
	toolBlockPadCols = pad;
	// Align under body text after the status marker: `{pad}● ` is pad + 2 cols.
	toolResultPad = " ".repeat(pad + 2);
	toolResultPadCols = pad + 2;
}

function statusDot(theme: Theme, chrome: CallChrome = {}): string {
	if (chrome.isError) {
		return theme.fg("error", "●");
	}
	if (chrome.isPartial) {
		return theme.fg("muted", "●");
	}
	return theme.fg("accent", "●");
}

/**
 * Strip trailing spaces and detect visual blankness in a single pass.
 * Returns { core, blank } where core has trailing fill removed.
 */
function stripAndCheck(line: string): { core: string; blank: boolean } {
	// Scan for any visible (non-space, non-ANSI) character while finding the last non-fill char.
	let inAnsi = false;
	let hasContent = false;
	let lastContent = -1;
	for (let i = 0; i < line.length; i++) {
		const ch = line.charCodeAt(i);
		if (ch === 0x1b) { inAnsi = true; lastContent = i; continue; }
		if (inAnsi) { if (ch === 0x6d) inAnsi = false; lastContent = i; continue; } // 'm'
		if (ch === 0x20) continue; // space — possible fill
		lastContent = i;
		hasContent = true;
	}
	return {
		core: lastContent < 0 ? "" : line.slice(0, lastContent + 1),
		blank: !hasContent,
	};
}

function finishChromeLine(indent: string, core: string): string {
	// Do not right-pad to terminal width: trailing spaces often wrap into a fake blank line.
	// Self-shell has no full-width background that needs filling.
	return `${indent}${core}`;
}

/** Pad every result line so content hangs under the call title (after `● `). */
function padBlock(body: Component): Component {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(width, 1);
			if (cachedLines && cachedWidth === safeWidth) {
				return cachedLines;
			}
			const indent = toolResultPad;
			const innerWidth = Math.max(safeWidth - toolResultPadCols, 1);
			const raw = body.render(innerWidth).map(stripAndCheck);
			// Drop leading blanks so we don't get a gap under the call line; keep mid-output blanks.
			let start = 0;
			while (start < raw.length && raw[start]!.blank) {
				start += 1;
			}
			const lines = raw
				.slice(start)
				.map((item) => finishChromeLine(indent, item.blank ? "" : item.core));
			cachedWidth = safeWidth;
			cachedLines = lines;
			return lines;
		},
		invalidate() {},
	};
}

/**
 * Call chrome: `{pad}● body`, with wrapped continuations hanging under the title
 * (same indent as results). Always go through padCallBlock — baking the prefix into
 * a single Text lets wrap restart at column 0 and lose padding.
 */
function callLine(theme: Theme, chrome: CallChrome, body: string): Component {
	return padCallBlock(text(body), theme, chrome);
}

/** Pad a multi-line body and put `●` on the first line. Used for foreign tool wraps. */
function padCallBlock(body: Component, theme: Theme, chrome: CallChrome = {}): Component {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(width, 1);
			if (cachedLines && cachedWidth === safeWidth) {
				return cachedLines;
			}
			const indent = toolBlockPad;
			const resultIndent = toolResultPad;
			const dot = statusDot(theme, chrome);
			const firstPrefix = `${indent}${dot} `;
			const firstCols = toolBlockPadCols + 2; // pad + "● "
			const firstInner = Math.max(safeWidth - firstCols, 1);
			const raw = body
				.render(firstInner)
				.map(stripAndCheck)
				.filter((item) => !item.blank);
			const out =
				raw.length === 0
					? [firstPrefix.trimEnd()]
					: raw.map((item, index) =>
							finishChromeLine(index === 0 ? firstPrefix : resultIndent, item.core),
					  );
			cachedWidth = safeWidth;
			cachedLines = out;
			return out;
		},
		invalidate() {},
	};
}

/**
 * Generic self-shell chrome for any tool renderer pair.
 * Body renderers return content only (no pad/dot); this layer adds:
 * - renderShell: "self"
 * - block pad (config.paddingX) on every line
 * - status ● on the first call line
 */
function withSelfShell<TCall extends (...args: any[]) => Component, TResult extends (...args: any[]) => Component>(handlers: {
	renderCall: TCall;
	renderResult: TResult;
}): { renderShell: "self"; renderCall: TCall; renderResult: TResult } {
	return {
		renderShell: "self",
		renderCall: ((...args: any[]) => {
			const theme = args[1] as Theme;
			const context = (args[2] ?? {}) as CallChrome;
			return padCallBlock(handlers.renderCall(...args), theme, context);
		}) as TCall,
		renderResult: ((...args: any[]) => padBlock(handlers.renderResult(...args))) as TResult,
	};
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
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(width, 1);
			if (cachedLines && cachedWidth === safeWidth) {
				return cachedLines;
			}
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
			cachedWidth = safeWidth;
			cachedLines = lines;
			return lines;
		},
		// Content is fixed for a given result snapshot; keep width cache across invalidates.
		invalidate() {},
	};
}

const RTK_REWRITE_RECORD_TTL_MS = 60_000;
const originalBashCommands = new Map<string, string>();
const rewrittenBashCommands = new Set<string>();

function commandFromToolInput(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const command = (value as { command?: unknown }).command;
	return typeof command === "string" ? command : undefined;
}

function rememberRtkRewrite(toolCallId: unknown, original: unknown, actual: unknown): void {
	if (typeof toolCallId !== "string") {
		return;
	}
	const originalCommand = typeof original === "string" ? original : undefined;
	const actualCommand = typeof actual === "string" ? actual : undefined;
	if (!originalCommand || !actualCommand) {
		return;
	}
	if (isRtkRewrite(originalCommand, actualCommand)) {
		rewrittenBashCommands.add(toolCallId);
	}
}

type BashRenderState = {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
	rtkRewritten?: boolean;
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
	return theme.fg("muted", formatBashTimingLine(duration, when, isPartial, state.rtkRewritten === true));
}

/** Expanded bash view: output (+ full command only when call folded it away). */
function renderExpandedBash(
	command: string,
	output: string,
	status: string | undefined,
	warning: string | undefined,
	timing: string | undefined,
	theme: Theme,
	revealCommand: boolean,
): Component {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(width, 1);
			if (cachedLines && cachedWidth === safeWidth) {
				return cachedLines;
			}
			const lines: string[] = [];
			if (status) {
				lines.push(...new Text(status, 0, 0).render(safeWidth));
			}
			// Only re-print the command when the call view truncated it.
			if (revealCommand && command.length > 0) {
				lines.push(theme.fg("dim", "command"));
				const commandStyled = `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", command)}`;
				lines.push(...new Text(commandStyled, 0, 0).render(safeWidth));
			}
			if (output.length > 0) {
				if (revealCommand && command.length > 0) {
					lines.push(theme.fg("dim", "output"));
				}
				lines.push(...new Text(theme.fg("toolOutput", output), 0, 0).render(safeWidth));
			} else if (!status) {
				lines.push(theme.fg("muted", "(no output)"));
			}
			if (warning) {
				lines.push(...new Text(warning, 0, 0).render(safeWidth));
			}
			if (timing) {
				lines.push(...new Text(timing, 0, 0).render(safeWidth));
			}
			cachedWidth = safeWidth;
			cachedLines = lines;
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
	applyChromeConfig(config);
	const referenceTools = getBuiltInTools(cwd);
	const editPrepareArguments = getEditPrepareArguments(referenceTools.edit);

	if (config.enabled.read) {
		pi.registerTool({
			name: "read",
			label: "read",
			renderShell: "self",
			description: referenceTools.read.description,
			...getToolPromptMetadata(pi, "read"),
			parameters: referenceTools.read.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme, context) {
				const displayPath = formatDisplayPath(args.path ?? "", {
					offset: typeof args.offset === "number" ? args.offset : undefined,
					limit: typeof args.limit === "number" ? args.limit : undefined,
				});
				return callLine(theme, context, `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", displayPath)}`);
			},
			renderResult(result, { isPartial }, theme) {
				if (isPartial) {
					return padBlock(text(theme.fg("muted", "loading...")));
				}
				const resultText = extractTextContent(result);
				if (isErrorResult(result, resultText)) {
					return padBlock(renderRawText(resultText, theme, true));
				}
				return empty();
			},
		});
	}

	if (config.enabled.write) {
		pi.registerTool({
			name: "write",
			label: "write",
			renderShell: "self",
			description: referenceTools.write.description,
			...getToolPromptMetadata(pi, "write"),
			parameters: referenceTools.write.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme, context) {
				const displayPath = formatDisplayPath(args.path ?? "");
				const lineCount = countLines(args.content ?? "");
				return callLine(theme, context, `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", displayPath)} ${theme.fg("muted", `(${formatLineCount(lineCount)})`)}`);
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) {
					return padBlock(text(theme.fg("muted", "Writing...")));
				}
				const resultText = extractTextContent(result);
				if (isErrorResult(result, resultText)) {
					return padBlock(renderRawText(resultText, theme, true));
				}
				const content = typeof context.args?.content === "string" ? context.args.content : "";
				const lineCount = countLines(content);
				if (!expanded) {
					const summary = `${theme.fg("muted", `wrote ${formatLineCount(lineCount)}`)} ${expandHint(theme)}`;
					return padBlock(text(summary));
				}
				const display = content.length > 0 ? theme.fg("toolOutput", content) : theme.fg("muted", "(empty file)");
				return padBlock(text(display));
			},
		});
	}

	if (config.enabled.bash) {
		pi.registerTool({
			name: "bash",
			label: "bash",
			renderShell: "self",
			description: referenceTools.bash.description,
			...getToolPromptMetadata(pi, "bash"),
			parameters: referenceTools.bash.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme, context) {
				const command = typeof args.command === "string" ? args.command : "";
				const lines = command.replace(/\r\n/g, "\n").split("\n");
				const maxLines = Math.max(1, config.bashCallPreviewLines);
				const shown = lines.slice(0, maxLines);
				const hidden = Math.max(0, lines.length - shown.length);
				const first = shown[0] ?? "";
				const rest = shown.slice(1);
				let head = `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", first)}`;
				if (typeof args.timeout === "number") {
					head += ` ${theme.fg("muted", `(timeout ${args.timeout}s)`)}`;
				}
				if (rest.length === 0 && hidden === 0) {
					return callLine(theme, context, head);
				}
				// Multi-line call: hang under ●; fold when over bashCallPreviewLines.
				const bodyLines = [head, ...rest.map((line) => theme.fg("accent", line))];
				if (hidden > 0) {
					bodyLines.push(
						theme.fg("muted", `… ${hidden} more ${pluralize(hidden, "line")} (${editorHint("to expand", theme)})`),
					);
				}
				return padCallBlock(text(bodyLines.join("\n")), theme, context);
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				const resultText = extractTextContent(result);
				const isError = isErrorResult(result, resultText);
				const command = typeof context.args?.command === "string" ? context.args.command : "";
				const state = context.state as BashRenderState & {
					viewKey?: string;
					viewComponent?: Component;
				};
				if (rewrittenBashCommands.has(context.toolCallId)) {
					state.rtkRewritten = true;
				}
				const timing = bashTimingLine(state, isPartial, context.executionStarted, context.invalidate, theme);
				// While running, timing changes every second so the key must include it.
				// After completion the result is immutable and the component is reused across invalidates.
				const viewKey = [
					expanded ? "1" : "0",
					isPartial ? "1" : "0",
					isError ? "1" : "0",
					resultText,
					command,
					timing ?? "",
				].join("\0");
				if (state.viewKey === viewKey && state.viewComponent) {
					return state.viewComponent;
				}

				let component: Component;
				if (isError) {
					const output = resultText.trim();
					const prefix = theme.fg("error", "command failed");
					component = !expanded && output.length > 0
						? renderVisualTail(theme.fg("error", output), prefix, timing, theme, config.bashPreviewLines)
						: text(joinSections(prefix, output.length > 0 ? theme.fg("error", output) : undefined, timing));
				} else {
					const { body, notice } = splitTrailingNoticeBlock(resultText);
					const previewSource = (body.length > 0 ? body : resultText).trim();
					const status = isPartial ? theme.fg("warning", "running...") : undefined;
					const warning = warningLine(notice, theme);

					if (!expanded && previewSource.length > 0) {
						component = renderVisualTail(
							theme.fg("toolOutput", previewSource),
							status,
							joinSections(warning, timing),
							theme,
							config.bashPreviewLines,
						);
					} else if (expanded) {
						const commandFolded = command.replace(/\r\n/g, "\n").split("\n").length > config.bashCallPreviewLines;
						component = renderExpandedBash(
							command,
							previewSource,
							status,
							warning,
							timing,
							theme,
							config.bashRevealCommand && commandFolded,
						);
					} else {
						const display = previewSource.length > 0
							? theme.fg("toolOutput", previewSource)
							: !isPartial ? theme.fg("muted", "(no output)") : undefined;
						component = text(joinSections(status, display, warning, timing));
					}
				}
				const framed = padBlock(component);
				state.viewKey = viewKey;
				state.viewComponent = framed;
				return framed;
			},
		});
	}

	if (config.enabled.edit) {
		pi.registerTool({
			name: "edit",
			label: "edit",
			renderShell: "self",
			description: referenceTools.edit.description,
			...getToolPromptMetadata(pi, "edit"),
			parameters: referenceTools.edit.parameters,
			...(editPrepareArguments ? { prepareArguments: editPrepareArguments } : {}),
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme, context) {
				const displayPath = formatDisplayPath(args.path ?? "");
				const edits = Array.isArray(args.edits) ? args.edits.length : 0;
				const suffix = edits > 0 ? ` ${theme.fg("muted", `(${edits} ${pluralize(edits, "block")})`)}` : "";
				return callLine(theme, context, `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", displayPath)}${suffix}`);
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) {
					return padBlock(text(theme.fg("muted", "Editing...")));
				}
				const resultText = extractTextContent(result);
				if (context.isError || isErrorResult(result, resultText)) {
					return padBlock(renderRawText(resultText, theme, true));
				}
				const details = (result as { details?: { diff?: unknown } }).details;
				const diff = typeof details?.diff === "string" ? details.diff : "";
				if (!diff) {
					return padBlock(text(theme.fg("success", "Applied")));
				}
				const filePath = typeof context.args?.path === "string" ? context.args.path : undefined;
				const state = context.state as {
					diffKey?: string;
					diffComponent?: Component;
				};
				// Collapsed by default; expand with Ctrl+O for the full adaptive diff.
				const diffKey = [
					expanded ? "1" : "0",
					diff,
					filePath ?? "",
					config.diffMode,
					String(config.diffColumnWidth),
					config.diffSyntaxHighlight ? "1" : "0",
				].join("\0");
				if (state.diffKey === diffKey && state.diffComponent) {
					return state.diffComponent;
				}
				let component: Component;
				if (!expanded) {
					const stats = getDiffStats(diff);
					const summary = [
						theme.fg("muted", "diff"),
						theme.fg("toolDiffAdded", `+${stats.additions}`),
						theme.fg("toolDiffRemoved", `-${stats.removals}`),
						theme.fg("muted", `${stats.hunks} ${pluralize(stats.hunks, "hunk")}`),
					].join(theme.fg("muted", " • "));
					component = padBlock(text(`${summary} ${expandHint(theme)}`));
				} else {
					component = padBlock(
						renderDiff(
							diff,
							{
								filePath,
								mode: config.diffMode,
								columnWidth: config.diffColumnWidth,
								syntaxHighlight: config.diffSyntaxHighlight,
							},
							theme,
						),
					);
				}
				state.diffKey = diffKey;
				state.diffComponent = component;
				return component;
			},
		});
	}

	if (config.enabled.grep) {
		pi.registerTool({
			name: "grep",
			label: "grep",
			renderShell: "self",
			description: referenceTools.grep.description,
			...getToolPromptMetadata(pi, "grep"),
			parameters: referenceTools.grep.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme, context) {
				let value = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", args.literal ? JSON.stringify(args.pattern ?? "") : `/${args.pattern ?? ""}/`)}`;
				value += theme.fg("muted", ` in ${formatDisplayPath(args.path ?? ".")}`);
				if (args.glob) {
					value += ` ${theme.fg("dim", `(${args.glob})`)}`;
				}
				return callLine(theme, context, value);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					return padBlock(text(theme.fg("muted", "Searching...")));
				}
				const resultText = extractTextContent(result);
				if (isErrorResult(result, resultText)) {
					return padBlock(renderRawText(resultText, theme, true));
				}
				const { body, notice } = splitTrailingNoticeBlock(resultText);
				if (expanded) {
					return padBlock(text(theme.fg("toolOutput", joinSections(body || resultText || theme.fg("muted", "(no matches)"), warningLine(notice, theme)))));
				}
				const count = countGrepMatches(resultText);
				const summary = `${theme.fg("muted", `${count} ${pluralize(count, "match")}`)} ${expandHint(theme)}`;
				return padBlock(text(joinSections(summary, warningLine(notice, theme))));
			},
		});
	}

	if (config.enabled.find) {
		pi.registerTool({
			name: "find",
			label: "find",
			renderShell: "self",
			description: referenceTools.find.description,
			...getToolPromptMetadata(pi, "find"),
			parameters: referenceTools.find.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme, context) {
				let value = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern ?? "")}`;
				value += theme.fg("muted", ` in ${formatDisplayPath(args.path ?? ".")}`);
				if (typeof args.limit === "number") {
					value += ` ${theme.fg("dim", `(limit ${args.limit})`)}`;
				}
				return callLine(theme, context, value);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					return padBlock(text(theme.fg("muted", "Searching...")));
				}
				const resultText = extractTextContent(result);
				if (isErrorResult(result, resultText)) {
					return padBlock(renderRawText(resultText, theme, true));
				}
				const { body, notice } = splitTrailingNoticeBlock(resultText);
				if (expanded) {
					return padBlock(text(theme.fg("toolOutput", joinSections(body || resultText || theme.fg("muted", "(no files)"), warningLine(notice, theme)))));
				}
				const count = countFindResults(resultText);
				const summary = `${theme.fg("muted", `${count} ${pluralize(count, "file")}`)} ${expandHint(theme)}`;
				return padBlock(text(joinSections(summary, warningLine(notice, theme))));
			},
		});
	}

	if (config.enabled.ls) {
		pi.registerTool({
			name: "ls",
			label: "ls",
			renderShell: "self",
			description: referenceTools.ls.description,
			...getToolPromptMetadata(pi, "ls"),
			parameters: referenceTools.ls.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme, context) {
				let value = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", formatDisplayPath(args.path ?? "."))}`;
				if (typeof args.limit === "number") {
					value += ` ${theme.fg("dim", `(limit ${args.limit})`)}`;
				}
				return callLine(theme, context, value);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					return padBlock(text(theme.fg("muted", "Listing...")));
				}
				const resultText = extractTextContent(result);
				if (isErrorResult(result, resultText)) {
					return padBlock(renderRawText(resultText, theme, true));
				}
				const { body, notice } = splitTrailingNoticeBlock(resultText);
				if (expanded) {
					return padBlock(text(theme.fg("toolOutput", joinSections(body || resultText || theme.fg("muted", "(empty directory)"), warningLine(notice, theme)))));
				}
				const count = countLsEntries(resultText);
				const summary = `${theme.fg("muted", `${count} ${pluralize(count, "entry")}`)} ${expandHint(theme)}`;
				return padBlock(text(joinSections(summary, warningLine(notice, theme))));
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

const TOOL_SHELL_PATCH_FLAG = Symbol.for("@ssparkluo/my-pi.tool-display.tool-shell-patch");
const fffRendererPatched = new WeakSet<object>();
const foreignShellPatched = new WeakSet<object>();

/** Loaded before the first registry build; refreshed on session_start. */
let fffDisplayConfig: ToolDisplayConfig = loadConfig().config;
applyChromeConfig(fffDisplayConfig);

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
		renderCall(args: Record<string, unknown>, theme: Theme, context?: CallChrome) {
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
				return text(theme.fg("toolOutput", body || resultText || theme.fg("muted", "(no matches)")));
			}
			const count = totalMatchedFromDetails(result) ?? countFffGrepMatches(resultText);
			const summary = `${theme.fg("muted", `${count} ${pluralize(count, "match")}`)} ${expandHint(theme)}`;
			return text(summary);
		},
	};
}

function createFffFindRenderers() {
	return {
		renderCall(args: Record<string, unknown>, theme: Theme, context?: CallChrome) {
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
				return text(theme.fg("toolOutput", body || resultText || theme.fg("muted", "(no files)")));
			}
			const count = totalMatchedFromDetails(result) ?? countFffFindResults(resultText);
			const summary = `${theme.fg("muted", `${count} ${pluralize(count, "file")}`)} ${expandHint(theme)}`;
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

function isOurToolName(name: string): name is ToolName {
	return (ALL_TOOL_NAMES as readonly string[]).includes(name);
}

type PatchableToolDefinition = {
	name?: string;
	renderShell?: "default" | "self";
	renderCall?: (...args: any[]) => Component;
	renderResult?: (...args: any[]) => Component;
};

/**
 * Apply the generic self-shell without editing tool source:
 * - fffind/ffgrep: inject our compact body renderers + withSelfShell
 * - our 7 built-ins: already registered with padCallBlock/padBlock; pin self
 * - every other tool: wrap existing renderCall/renderResult with withSelfShell
 *   (execute untouched; no foreign source changes)
 */
function installToolShellPatch(): void {
	const proto = ExtensionRunner.prototype as unknown as Record<string | symbol, unknown>;
	if (proto[TOOL_SHELL_PATCH_FLAG]) {
		return;
	}

	const original = proto.getAllRegisteredTools as (this: ExtensionRunner) => Array<{
		definition: PatchableToolDefinition;
	}>;
	proto.getAllRegisteredTools = function patchedGetAllRegisteredTools(this: ExtensionRunner) {
		const tools = original.call(this);
		for (const tool of tools) {
			const definition = tool.definition;
			const name = definition.name;
			if (typeof name !== "string") {
				continue;
			}

			// FFF: replace body renderers, then apply the same generic shell.
			if (isFffToolName(name) && isToolEnabled(name)) {
				if (!fffRendererPatched.has(definition)) {
					const shelled = withSelfShell(fffRenderers[name]);
					definition.renderShell = shelled.renderShell;
					definition.renderCall = shelled.renderCall;
					definition.renderResult = shelled.renderResult;
					fffRendererPatched.add(definition);
					foreignShellPatched.add(definition);
				}
				continue;
			}

			// Our compact overrides already include pad + ●; only pin self shell.
			if (isOurToolName(name) && isToolEnabled(name)) {
				definition.renderShell = "self";
				continue;
			}

			// Foreign tools: apply self shell + pad/dot without swallowing their output.
			// Critical: do NOT invent an empty renderResult — when it's missing, pi falls
			// back to createResultFallback() which shows the tool's text content.
			if (foreignShellPatched.has(definition)) {
				continue;
			}
			const toolName = name;
			const origCall = definition.renderCall;
			const origResult = definition.renderResult;
			definition.renderShell = "self";
			definition.renderCall = ((...args: any[]) => {
				const theme = args[1] as Theme;
				const context = (args[2] ?? {}) as CallChrome;
				if (origCall) {
					return padCallBlock(origCall(...args), theme, context);
				}
				return callLine(theme, context, theme.fg("toolTitle", theme.bold(toolName)));
			}) as typeof definition.renderCall;
			if (origResult) {
				definition.renderResult = ((...args: any[]) => padBlock(origResult(...args))) as typeof definition.renderResult;
			} else {
				// Mirror ToolExecution.createResultFallback + our pad — do not leave empty.
				definition.renderResult = ((result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }, { isPartial }: { isPartial: boolean }, theme: Theme) => {
					if (isPartial) {
						return empty();
					}
					const resultText = extractTextContent(result);
					if (!resultText.trim()) {
						return empty();
					}
					if (isErrorResult(result, resultText)) {
						return padBlock(renderRawText(resultText, theme, true));
					}
					return padBlock(text(theme.fg("toolOutput", resultText)));
				}) as typeof definition.renderResult;
			}
			foreignShellPatched.add(definition);
		}
		return tools;
	};
	proto[TOOL_SHELL_PATCH_FLAG] = true;
}

// Install early so the first registry build picks up shell + FFF overrides.
installToolShellPatch();

export default function (pi: ExtensionAPI) {
	let registered = false;

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "bash") {
			return;
		}
		const command = commandFromToolInput(event.args);
		if (command !== undefined) {
			originalBashCommands.set(event.toolCallId, command);
		}
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") {
			return;
		}
		rememberRtkRewrite(event.toolCallId, originalBashCommands.get(event.toolCallId), commandFromToolInput(event.input));
	});

	pi.on("tool_execution_end", (event) => {
		originalBashCommands.delete(event.toolCallId);
		setTimeout(() => rewrittenBashCommands.delete(event.toolCallId), RTK_REWRITE_RECORD_TTL_MS).unref?.();
	});

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
		applyChromeConfig(config);
		const activeTools = pi.getActiveTools();
		registerOverrides(pi, ctx.cwd, config);
		// registerOverrides triggers refreshTools, which re-runs the shell/FFF patch with live config.
		pi.setActiveTools(activeTools);
		registered = true;
	});
}
