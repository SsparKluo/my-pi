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
	containerBgAnsi?: string;
};

const ANSI_BG_RESET = "\x1b[49m";
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const ADD_ROW_BACKGROUND_MIX_RATIO = 0.24;
const REMOVE_ROW_BACKGROUND_MIX_RATIO = 0.12;
const ADDITION_TINT_TARGET: RgbColor = { r: 84, g: 190, b: 118 };
const DELETION_TINT_TARGET: RgbColor = { r: 232, g: 95, b: 122 };

// ── ANSI / color math (adapted from sids) ──────────────────────────────────

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
	const stableText = keepBackgroundAcrossResets(fitted, rowBgAnsi);
	return `${rowBgAnsi}${stableText}${restoreBgAnsi}`;
}

function ansi256ToRgb(code: number): RgbColor {
	if (code < 0) {
		return { r: 0, g: 0, b: 0 };
	}
	if (code <= 15) {
		const base16: RgbColor[] = [
			{ r: 0, g: 0, b: 0 }, { r: 128, g: 0, b: 0 }, { r: 0, g: 128, b: 0 }, { r: 128, g: 128, b: 0 },
			{ r: 0, g: 0, b: 128 }, { r: 128, g: 0, b: 128 }, { r: 0, g: 128, b: 128 }, { r: 192, g: 192, b: 192 },
			{ r: 128, g: 128, b: 128 }, { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 255, g: 255, b: 0 },
			{ r: 0, g: 0, b: 255 }, { r: 255, g: 0, b: 255 }, { r: 0, g: 255, b: 255 }, { r: 255, g: 255, b: 255 },
		];
		return base16[code] ?? { r: 255, g: 255, b: 255 };
	}
	if (code >= 232) {
		const value = Math.max(0, Math.min(255, 8 + (code - 232) * 10));
		return { r: value, g: value, b: value };
	}
	const cube = code - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	const blue = cube % 6;
	const green = Math.floor(cube / 6) % 6;
	const red = Math.floor(cube / 36) % 6;
	return { r: levels[red] ?? 0, g: levels[green] ?? 0, b: levels[blue] ?? 0 };
}

function parseAnsiColorCode(ansi: string | undefined): RgbColor | null {
	if (!ansi) {
		return null;
	}
	const rgbMatch = /\x1b\[(?:3|4)8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
	if (rgbMatch) {
		const r = Number.parseInt(rgbMatch[1] ?? "0", 10);
		const g = Number.parseInt(rgbMatch[2] ?? "0", 10);
		const b = Number.parseInt(rgbMatch[3] ?? "0", 10);
		if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
			return {
				r: Math.max(0, Math.min(255, r)),
				g: Math.max(0, Math.min(255, g)),
				b: Math.max(0, Math.min(255, b)),
			};
		}
	}
	const ansi256Match = /\x1b\[(?:3|4)8;5;(\d{1,3})m/.exec(ansi);
	if (ansi256Match) {
		const code = Number.parseInt(ansi256Match[1] ?? "0", 10);
		if (Number.isFinite(code)) {
			return ansi256ToRgb(code);
		}
	}
	return null;
}

function rgbToBgAnsi(color: RgbColor): string {
	const r = Math.max(0, Math.min(255, Math.round(color.r)));
	const g = Math.max(0, Math.min(255, Math.round(color.g)));
	const b = Math.max(0, Math.min(255, Math.round(color.b)));
	return `\x1b[48;2;${r};${g};${b}m`;
}

function mixRgb(base: RgbColor, tint: RgbColor, ratio: number): RgbColor {
	const clamped = Math.max(0, Math.min(1, ratio));
	return {
		r: base.r * (1 - clamped) + tint.r * clamped,
		g: base.g * (1 - clamped) + tint.g * clamped,
		b: base.b * (1 - clamped) + tint.b * clamped,
	};
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
	const containerBgAnsi =
		readThemeAnsi(theme, "bg", "toolSuccessBg") ??
		readThemeAnsi(theme, "bg", "toolPendingBg") ??
		readThemeAnsi(theme, "bg", "toolErrorBg") ??
		readThemeAnsi(theme, "bg", "userMessageBg");
	const baseBg =
		parseAnsiColorCode(containerBgAnsi) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "userMessageBg")) ??
		{ r: 32, g: 35, b: 42 };
	const addFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffAdded")) ?? { r: 88, g: 173, b: 88 };
	const removeFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffRemoved")) ?? { r: 196, g: 98, b: 98 };
	const addTint = mixRgb(addFg, ADDITION_TINT_TARGET, 0.35);
	const removeTint = mixRgb(removeFg, DELETION_TINT_TARGET, 0.65);

	return {
		addRowBgAnsi: rgbToBgAnsi(mixRgb(baseBg, addTint, ADD_ROW_BACKGROUND_MIX_RATIO)),
		removeRowBgAnsi: rgbToBgAnsi(mixRgb(baseBg, removeTint, REMOVE_ROW_BACKGROUND_MIX_RATIO)),
		containerBgAnsi,
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

function formatSummary(diff: string, width: number, theme: DiffTheme): string {
	const stats = getDiffStats(diff);
	const summary = [
		theme.fg("toolOutput", `↳ ${emphasis(theme, "diff")}`),
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

function formatGapLine(skipped: number, width: number, theme: DiffTheme): string {
	const label = skipped === 1 ? "1 unchanged line" : `${skipped} unchanged lines`;
	return truncateToWidth(theme.fg("muted", `  ··· ${label} ···`), width);
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
	const restoreBg = palette.containerBgAnsi ?? ANSI_BG_RESET;
	return wrapped.map((line, index) => {
		const rowText = `${index === 0 ? prefix : continuationPrefix}${line}`;
		return bg ? applyLineBackgroundToWidth(rowText, width, bg, restoreBg) : fitToWidth(rowText, width);
	});
}

function renderSingleColumn(
	rows: Row[],
	numW: number,
	width: number,
	theme: DiffTheme,
	highlighter: (line: string) => string,
	palette: DiffPalette,
): string[] {
	const out: string[] = [];
	for (const row of rows) {
		if (row.type === "meta") {
			out.push(formatMetaLine(row.raw, width, theme));
			continue;
		}
		if (row.type === "gap") {
			out.push(formatGapLine(row.skipped, width, theme));
			continue;
		}
		if (row.type === "context") {
			out.push(
				...renderSingleLine(
					" ", "dim", String(row.oldNum), "dim", highlighter(row.content), undefined,
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
	highlighter: (line: string) => string,
	palette: DiffPalette,
): string[] {
	const restoreBg = palette.containerBgAnsi ?? ANSI_BG_RESET;
	// Layout: <lnum> │ <left> │ <rnum> │ <right>
	const overhead = 2 * numW + 9; // three " │ " separators (3 each) + two number columns
	const contentTotal = Math.max(width - overhead, 4);
	const colW = Math.floor(contentTotal / 2);
	const leftW = colW;
	const rightW = Math.max(contentTotal - colW, 1);

	const leftGutter = " │ ";
	const midGutter = " │ ";
	const blank = " ".repeat(colW);

	const out: string[] = [];
	for (const row of rows) {
		if (row.type === "meta") {
			out.push(formatMetaLine(row.raw, width, theme));
			continue;
		}
		if (row.type === "gap") {
			out.push(formatGapLine(row.skipped, width, theme));
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
			leftContent = fitToWidth(highlighter(row.content), leftW);
			rightContent = fitToWidth(highlighter(row.content), rightW);
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
			? applyLineBackgroundToWidth(leftContent, leftW, leftBg, restoreBg)
			: fitToWidth(leftContent, leftW);
		const rightCell = rightBg
			? applyLineBackgroundToWidth(rightContent, rightW, rightBg, restoreBg)
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

			const summary = formatSummary(diff, safeWidth, theme);
			const separator = theme.fg("dim", "─".repeat(safeWidth));
			const body =
				rows.length === 0
					? [theme.fg("muted", "(empty diff)")]
					: useDual
						? renderDualColumn(rows, numW, safeWidth, theme, highlighter, palette)
						: renderSingleColumn(rows, numW, safeWidth, theme, highlighter, palette);

			cachedLines = [summary, separator, ...body];
			cachedKey = `${safeWidth}:${useDual}`;
			return cachedLines;
		},
		invalidate() {
			cachedKey = undefined;
			cachedLines = undefined;
		},
	};
}
