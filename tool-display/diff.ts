/**
 * Adaptive diff renderer for tool-display.
 *
 * Single-column rendering, theme tinting, and the ANSI/background math are adapted from
 * @siddr/pi-tool-display (diff-renderer.ts) — MIT, https://github.com/sids/pi-extensions
 *
 * Diff parsing (with correct old/new line numbers) and inline word-diff live in ./diff-model.ts.
 * Added here vs sids: adaptive single-column <-> side-by-side layout chosen by width.
 */
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getDiffStats } from "./utils.ts";
import type { DiffMode } from "./config.ts";
import { buildRows, lineNumberWidth, parseEntries, type Row, type Seg } from "./diff-model.ts";

export type { DiffMode };

export type DiffRenderOptions = {
	filePath?: string;
	mode: DiffMode;
	/** Terminal width at/above which "auto" switches to side-by-side. */
	columnWidth: number;
	syntaxHighlight: boolean;
};

type DiffTheme = {
	fg(color: string, text: string): string;
	bold?(text: string): string;
	getFgAnsi?(color: string): string;
	getBgAnsi?(color: string): string;
};

type RgbColor = { r: number; g: number; b: number };

type DiffPalette = {
	addRowBgAnsi: string;
	removeRowBgAnsi: string;
};

const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const ANSI_BG_RESET = "\x1b[49m";

// ── ANSI helpers ───────────────────────────────────────────────────────────

function normalizeCodeWhitespace(text: string): string {
	return text.replace(/\t/g, " ");
}

function emphasis(theme: DiffTheme, text: string): string {
	return typeof theme.bold === "function" ? theme.bold(text) : text;
}

function fitToWidth(text: string, width: number): string {
	const trimmed = truncateToWidth(text, width, "");
	const gap = Math.max(0, width - visibleWidth(trimmed));
	return gap > 0 ? `${trimmed}${" ".repeat(gap)}` : trimmed;
}

function wrapToWidth(text: string, width: number): string[] {
	if (width <= 0) {
		return [""];
	}
	const wrapped = wrapTextWithAnsi(text, width);
	if (wrapped.length === 0) {
		return [fitToWidth("", width)];
	}
	return wrapped.map((line) => fitToWidth(line, width));
}

function toSgrParams(rawParams: string): number[] {
	if (!rawParams.trim()) {
		return [0];
	}
	const parsed = rawParams
		.split(";")
		.map((token) => Number.parseInt(token, 10))
		.filter((value) => Number.isFinite(value));
	return parsed.length > 0 ? parsed : [];
}

function sequenceResetsBackground(params: number[]): boolean {
	for (const param of params) {
		if (param === 0 || param === 49) {
			return true;
		}
	}
	return false;
}

function keepBackgroundAcrossResets(text: string, rowBg: string): string {
	if (!text) {
		return text;
	}
	return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		const params = toSgrParams(rawParams);
		if (params.length === 0 || !sequenceResetsBackground(params)) {
			return sequence;
		}
		return `${sequence}${rowBg}`;
	});
}

function applyLineBackgroundToWidth(
	text: string,
	width: number,
	rowBgAnsi: string,
	restoreBgAnsi: string,
): string {
	if (width <= 0) {
		return "";
	}
	const fitted = fitToWidth(text, width);
	// Skip SGR rewriting when the line has no escapes — common without syntax highlight.
	const stableText = fitted.includes("\x1b") ? keepBackgroundAcrossResets(fitted, rowBgAnsi) : fitted;
	return `${rowBgAnsi}${stableText}${restoreBgAnsi}`;
}

function rgbToBgAnsi(color: RgbColor): string {
	const r = Math.max(0, Math.min(255, Math.round(color.r)));
	const g = Math.max(0, Math.min(255, Math.round(color.g)));
	const b = Math.max(0, Math.min(255, Math.round(color.b)));
	return `\x1b[48;2;${r};${g};${b}m`;
}

function readThemeAnsi(theme: DiffTheme, kind: "fg" | "bg", slot: string): string | undefined {
	try {
		if (kind === "fg" && typeof theme.getFgAnsi === "function") {
			return theme.getFgAnsi(slot);
		}
		if (kind === "bg" && typeof theme.getBgAnsi === "function") {
			return theme.getBgAnsi(slot);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function resolveDiffPalette(theme: DiffTheme): DiffPalette {
	// Use the same soft success/error slab colors as pi's default renderShell.
	const successBg =
		readThemeAnsi(theme, "bg", "toolSuccessBg") ??
		rgbToBgAnsi({ r: 40, g: 50, b: 40 });
	const errorBg =
		readThemeAnsi(theme, "bg", "toolErrorBg") ??
		rgbToBgAnsi({ r: 60, g: 40, b: 40 });

	return {
		addRowBgAnsi: successBg,
		removeRowBgAnsi: errorBg,
	};
}

function createCodeHighlighter(
	filePath: string | undefined,
	enabled: boolean,
): (line: string) => string {
	if (!enabled) {
		return normalizeCodeWhitespace;
	}
	const language = filePath ? getLanguageFromPath(filePath) : undefined;
	if (!language) {
		return normalizeCodeWhitespace;
	}
	const cache = new Map<string, string>();
	return (line: string) => {
		const normalized = normalizeCodeWhitespace(line);
		const cached = cache.get(normalized);
		if (cached !== undefined) {
			return cached;
		}
		try {
			const highlighted = highlightCode(normalized, language)[0] ?? normalized;
			cache.set(normalized, highlighted);
			return highlighted;
		} catch {
			cache.set(normalized, normalized);
			return normalized;
		}
	};
}

// ── Segment rendering (word-diff emphasis) ─────────────────────────────────

function renderSegs(segs: Seg[], fgColor: string, theme: DiffTheme): string {
	let out = "";
	for (const seg of segs) {
		// Changed words are bolded on the line's tinted background; common words keep the line color.
		out += seg.common ? theme.fg(fgColor, seg.text) : emphasis(theme, theme.fg(fgColor, seg.text));
	}
	return out;
}

// ── Summary / meta (adapted from sids) ─────────────────────────────────────

function formatSummary(stats: ReturnType<typeof getDiffStats>, width: number, theme: DiffTheme): string {
	const summary = [
		theme.fg("toolOutput", `${emphasis(theme, "diff")}`),
		theme.fg("toolDiffAdded", `+${stats.additions}`),
		theme.fg("toolDiffRemoved", `-${stats.removals}`),
		theme.fg("muted", `${stats.hunks} ${stats.hunks === 1 ? "hunk" : "hunks"}`),
		theme.fg("muted", `${stats.files} ${stats.files === 1 ? "file" : "files"}`),
	].join(theme.fg("muted", " • "));
	return truncateToWidth(summary, width);
}

function formatMetaLine(rawLine: string, width: number, theme: DiffTheme): string {
	const normalized = normalizeCodeWhitespace(rawLine);
	const color = normalized.startsWith("@@")
		? "accent"
		: normalized.startsWith("+++") || normalized.startsWith("---")
			? "muted"
			: "toolDiffContext";
	return truncateToWidth(theme.fg(color, normalized), width);
}

function gapLabel(skipped: number): string {
	const count = skipped === 1 ? "1 unchanged line" : `${skipped} unchanged lines`;
	return `··· ${count} ···`;
}

function formatGapCell(skipped: number, width: number, theme: DiffTheme): string {
	const label = gapLabel(skipped);
	const leftPadding = " ".repeat(Math.max(Math.floor((width - visibleWidth(label)) / 2), 0));
	return fitToWidth(theme.fg("muted", `${leftPadding}${label}`), width);
}

function formatGapLine(skipped: number, width: number, theme: DiffTheme): string {
	return formatGapCell(skipped, width, theme);
}

function formatDualGapLine(
	skipped: number,
	numW: number,
	leftW: number,
	rightW: number,
	width: number,
	theme: DiffTheme,
): string {
	const numberCell = " ".repeat(numW);
	const gutter = theme.fg("dim", " │ ");
	return fitToWidth(
		`${numberCell}${gutter}${formatGapCell(skipped, leftW, theme)}${gutter}${numberCell}${gutter}${formatGapCell(skipped, rightW, theme)}`,
		width,
	);
}

// ── Single-column rendering ────────────────────────────────────────────────

function colorize(theme: DiffTheme, color: string, text: string, rowBg: string | undefined): string {
	const themed = theme.fg(color, text);
	if (!rowBg) {
		return themed;
	}
	return `${rowBg}${keepBackgroundAcrossResets(themed, rowBg)}${rowBg}`;
}

function renderSingleLine(
	marker: string,
	markerColor: string,
	num: string,
	numColor: string,
	content: string,
	bg: string | undefined,
	numW: number,
	width: number,
	theme: DiffTheme,
	palette: DiffPalette,
): string[] {
	const divider = colorize(theme, "dim", "│ ", bg);
	const numText = colorize(theme, numColor, num.padStart(numW, " "), bg);
	const markerText = marker === " " ? " " : colorize(theme, markerColor, marker, bg);
	const prefix = `${markerText} ${numText} ${divider}`;
	const continuationPrefix = `${" ".repeat(2)}${colorize(theme, "dim", " ".repeat(numW), bg)} ${divider}`;
	const codeWidth = Math.max(width - visibleWidth(prefix), 0);
	const wrapped = wrapToWidth(content, codeWidth);
	return wrapped.map((line, index) => {
		const rowText = `${index === 0 ? prefix : continuationPrefix}${line}`;
		if (!bg) {
			return fitToWidth(rowText, width);
		}
		// Reset bg at EOL so self-shell lines don't bleed into the next row.
		return applyLineBackgroundToWidth(rowText, width, bg, ANSI_BG_RESET);
	});
}

function renderSingleColumn(
	rows: Row[],
	numW: number,
	width: number,
	theme: DiffTheme,
	highlighter: (line: string, index: number) => string,
	palette: DiffPalette,
): string[] {
	const out: string[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!;
		if (row.type === "meta") {
			out.push(formatMetaLine(row.raw, width, theme));
			continue;
		}
		if (row.type === "gap") {
			out.push(formatGapLine(row.skipped, width, theme));
			continue;
		}
		if (row.type === "context") {
			const highlighted = highlighter(row.content, i);
			const contextColored = highlighted.includes("\x1b") ? highlighted : theme.fg("toolDiffContext", highlighted);
			out.push(
				...renderSingleLine(
					" ", "dim", String(row.oldNum), "dim", contextColored, undefined,
					numW, width, theme, palette,
				),
			);
			continue;
		}
		if (row.type === "del") {
			out.push(
				...renderSingleLine(
					"▌", "toolDiffRemoved", String(row.oldNum), "toolDiffRemoved",
					colorize(theme, "toolDiffRemoved", row.content, palette.removeRowBgAnsi),
					palette.removeRowBgAnsi, numW, width, theme, palette,
				),
			);
			continue;
		}
		if (row.type === "ins") {
			out.push(
				...renderSingleLine(
					"▌", "toolDiffAdded", String(row.newNum), "toolDiffAdded",
					colorize(theme, "toolDiffAdded", row.content, palette.addRowBgAnsi),
					palette.addRowBgAnsi, numW, width, theme, palette,
				),
			);
			continue;
		}
		// mod: remove line then add line, each with word-diff emphasis
		out.push(
			...renderSingleLine(
				"▌", "toolDiffRemoved", String(row.oldNum), "toolDiffRemoved",
				renderSegs(row.old, "toolDiffRemoved", theme),
				palette.removeRowBgAnsi, numW, width, theme, palette,
			),
		);
		out.push(
			...renderSingleLine(
				"▌", "toolDiffAdded", String(row.newNum), "toolDiffAdded",
				renderSegs(row.neu, "toolDiffAdded", theme),
				palette.addRowBgAnsi, numW, width, theme, palette,
			),
		);
	}
	return out;
}

// ── Side-by-side rendering ─────────────────────────────────────────────────

function renderDualColumn(
	rows: Row[],
	numW: number,
	width: number,
	theme: DiffTheme,
	highlighter: (line: string, index: number) => string,
	palette: DiffPalette,
): string[] {
	// Layout: <lnum> │ <left> │ <rnum> │ <right>
	const overhead = 2 * numW + 9; // three " │ " separators (3 each) + two number columns
	const contentTotal = Math.max(width - overhead, 4);
	const colW = Math.floor(contentTotal / 2);
	const leftW = colW;
	const rightW = Math.max(contentTotal - colW, 1);

	const leftGutter = theme.fg("dim", " │ ");
	const midGutter = theme.fg("dim", " │ ");
	const blank = " ".repeat(colW);

	const out: string[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!;
		if (row.type === "meta") {
			out.push(formatMetaLine(row.raw, width, theme));
			continue;
		}
		if (row.type === "gap") {
			out.push(formatDualGapLine(row.skipped, numW, leftW, rightW, width, theme));
			continue;
		}

		let leftNum = "";
		let leftContent = "";
		let leftBg: string | undefined;
		let rightNum = "";
		let rightContent = "";
		let rightBg: string | undefined;

		if (row.type === "context") {
			leftNum = String(row.oldNum);
			rightNum = String(row.newNum);
			const highlighted = highlighter(row.content, i);
			const contextColored = highlighted.includes("\x1b") ? highlighted : theme.fg("toolDiffContext", highlighted);
			leftContent = fitToWidth(contextColored, leftW);
			rightContent = fitToWidth(contextColored, rightW);
		} else if (row.type === "del") {
			leftNum = String(row.oldNum);
			leftBg = palette.removeRowBgAnsi;
			leftContent = fitToWidth(theme.fg("toolDiffRemoved", row.content), leftW);
			rightContent = blank;
		} else if (row.type === "ins") {
			rightNum = String(row.newNum);
			rightBg = palette.addRowBgAnsi;
			leftContent = blank;
			rightContent = fitToWidth(theme.fg("toolDiffAdded", row.content), rightW);
		} else {
			// mod
			leftNum = String(row.oldNum);
			rightNum = String(row.newNum);
			leftBg = palette.removeRowBgAnsi;
			rightBg = palette.addRowBgAnsi;
			leftContent = fitToWidth(renderSegs(row.old, "toolDiffRemoved", theme), leftW);
			rightContent = fitToWidth(renderSegs(row.neu, "toolDiffAdded", theme), rightW);
		}

		const leftNumText = colorize(theme, leftBg ? "toolDiffRemoved" : "dim", leftNum.padStart(numW, " "), leftBg);
		const rightNumText = colorize(theme, rightBg ? "toolDiffAdded" : "dim", rightNum.padStart(numW, " "), rightBg);
		const leftCell = leftBg
			? applyLineBackgroundToWidth(leftContent, leftW, leftBg, ANSI_BG_RESET)
			: fitToWidth(leftContent, leftW);
		const rightCell = rightBg
			? applyLineBackgroundToWidth(rightContent, rightW, rightBg, ANSI_BG_RESET)
			: fitToWidth(rightContent, rightW);

		const line = `${leftNumText}${leftGutter}${leftCell}${midGutter}${rightNumText}${leftGutter}${rightCell}`;
		out.push(fitToWidth(line, width));
	}
	return out;
}

// ── Public entry ───────────────────────────────────────────────────────────

export function renderDiff(diff: string, options: DiffRenderOptions, theme: DiffTheme): Component {
	const rows = buildRows(parseEntries(diff));
	const numW = lineNumberWidth(rows);
	const highlighter = createCodeHighlighter(options.filePath, options.syntaxHighlight);
	const palette = resolveDiffPalette(theme);
	const stats = getDiffStats(diff);

	// Highlight context once up front so dual-column never re-highlights the same line twice
	// and width-only reflows stay layout-only.
	const contextText = new Map<number, string>();
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row?.type === "context") {
			contextText.set(i, highlighter(row.content));
		}
	}
	const contextHighlighter = (line: string, index: number) => contextText.get(index) ?? highlighter(line);

	let cachedKey: string | undefined;
	let cachedLines: string[] | undefined;

	return {
		render(width: number): string[] {
			const safeWidth = Math.max(width, 1);
			const useDual =
				options.mode === "dual" || (options.mode === "auto" && safeWidth >= options.columnWidth);

			if (cachedLines && cachedKey === `${safeWidth}:${useDual}`) {
				return cachedLines;
			}

			const summary = formatSummary(stats, safeWidth, theme);
			const separator = theme.fg("dim", "─".repeat(safeWidth));
			const body =
				rows.length === 0
					? [theme.fg("muted", "(empty diff)")]
					: useDual
						? renderDualColumn(rows, numW, safeWidth, theme, contextHighlighter, palette)
						: renderSingleColumn(rows, numW, safeWidth, theme, contextHighlighter, palette);

			cachedLines = [summary, separator, ...body];
			cachedKey = `${safeWidth}:${useDual}`;
			return cachedLines;
		},
		// Diff content is immutable after the tool result lands. Keep the width cache across
		// ToolExecution.invalidate()/updateDisplay cycles so we do not re-layout every keystroke.
		invalidate() {},
	};
}
