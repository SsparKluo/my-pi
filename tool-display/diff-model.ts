/**
 * Pure diff model: parses pi's unified diff into structured rows and computes
 * inline word-diffs. Zero pi dependencies (only ./utils), so it is unit-testable
 * in plain node. The rendering layer (./diff.ts) consumes these structures.
 */
import { splitLines } from "./utils.ts";

export type DiffEntry =
	| { kind: "context"; oldNum: number; newNum: number; content: string }
	| { kind: "remove"; oldNum: number; content: string }
	| { kind: "add"; newNum: number; content: string }
	| { kind: "meta"; raw: string };

export type Seg = { text: string; common: boolean };

export type Row =
	| { type: "context"; oldNum: number; newNum: number; content: string }
	| { type: "mod"; oldNum: number; newNum: number; old: Seg[]; neu: Seg[] }
	| { type: "del"; oldNum: number; content: string }
	| { type: "ins"; newNum: number; content: string }
	| { type: "meta"; raw: string }
	| { type: "gap"; skipped: number };

function isChangeRow(row: Row | undefined): boolean {
	return row?.type === "mod" || row?.type === "del" || row?.type === "ins";
}

/** Minimum context-run length between change blocks that is collapsed. */
export const CONTEXT_COLLAPSE_AT = 7;
/** Context lines kept on each side of a collapsed gap. */
export const CONTEXT_EDGE = 3;

const diffLinePattern = /^([+\- ])(\s*\d*)\s(.*)$/;

/**
 * Parse pi's display diff. Line formats:
 *   ` N content`  context (advances old & new); `+N content` added (new); `-N content` removed (old).
 * `delta = newNum - oldNum` accumulates from adds/removes so context rows carry correct new-file numbers.
 */
export function parseEntries(diff: string): DiffEntry[] {
	const entries: DiffEntry[] = [];
	let delta = 0;
	for (const line of splitLines(diff)) {
		const match = line.match(diffLinePattern);
		if (!match) {
			entries.push({ kind: "meta", raw: line });
			continue;
		}
		const sign = match[1] ?? " ";
		const num = Number.parseInt((match[2] ?? "").trim(), 10);
		const content = match[3] ?? "";
		if (sign === "+") {
			entries.push({ kind: "add", newNum: Number.isFinite(num) ? num : 0, content });
			delta += 1;
		} else if (sign === "-") {
			entries.push({ kind: "remove", oldNum: Number.isFinite(num) ? num : 0, content });
			delta -= 1;
		} else {
			const oldNum = Number.isFinite(num) ? num : 0;
			entries.push({ kind: "context", oldNum, newNum: oldNum + delta, content });
		}
	}
	return entries;
}

export function tokenize(text: string): string[] {
	return text.match(/\S+|\s+/g) ?? (text.length ? [text] : []);
}

/** Longest-common-subsequence over tokens; marks tokens present in the common alignment. */
export function wordDiff(oldStr: string, newStr: string): { old: Seg[]; neu: Seg[] } {
	const a = tokenize(oldStr);
	const b = tokenize(newStr);
	const n = a.length;
	const m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const oldCommon = new Array<boolean>(n).fill(false);
	const newCommon = new Array<boolean>(m).fill(false);
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			oldCommon[i] = true;
			newCommon[j] = true;
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return {
		old: a.map((text, k) => ({ text, common: oldCommon[k] })),
		neu: b.map((text, k) => ({ text, common: newCommon[k] })),
	};
}

/** Group consecutive removes + adds into modified pairs; pure removes/adds become del/ins. */
export function buildRows(entries: DiffEntry[]): Row[] {
	const rows: Row[] = [];
	let i = 0;
	while (i < entries.length) {
		const entry = entries[i];
		if (entry === undefined) {
			break;
		}
		if (entry.kind === "context") {
			rows.push({ type: "context", oldNum: entry.oldNum, newNum: entry.newNum, content: entry.content });
			i++;
			continue;
		}
		if (entry.kind === "meta") {
			rows.push({ type: "meta", raw: entry.raw });
			i++;
			continue;
		}
		const rems: { oldNum: number; content: string }[] = [];
		const adds: { newNum: number; content: string }[] = [];
		while (i < entries.length) {
			const e = entries[i];
			if (e && e.kind === "remove") {
				rems.push({ oldNum: e.oldNum, content: e.content });
				i++;
			} else {
				break;
			}
		}
		while (i < entries.length) {
			const e = entries[i];
			if (e && e.kind === "add") {
				adds.push({ newNum: e.newNum, content: e.content });
				i++;
			} else {
				break;
			}
		}
		const pairs = Math.min(rems.length, adds.length);
		for (let k = 0; k < pairs; k++) {
			const r = rems[k];
			const a = adds[k];
			const { old: oldSegs, neu: newSegs } = wordDiff(r.content, a.content);
			rows.push({ type: "mod", oldNum: r.oldNum, newNum: a.newNum, old: oldSegs, neu: newSegs });
		}
		for (let k = pairs; k < rems.length; k++) {
			rows.push({ type: "del", oldNum: rems[k].oldNum, content: rems[k].content });
		}
		for (let k = pairs; k < adds.length; k++) {
			rows.push({ type: "ins", newNum: adds[k].newNum, content: adds[k].content });
		}
	}
	return collapseDistantContext(rows);
}

/**
 * When two change blocks are far apart, drop their middle context so the diff
 * stays focused on edits. Keeps CONTEXT_EDGE lines on each side of a gap.
 */
export function collapseDistantContext(
	rows: Row[],
	collapseAt = CONTEXT_COLLAPSE_AT,
	edge = CONTEXT_EDGE,
): Row[] {
	const out: Row[] = [];
	let i = 0;
	while (i < rows.length) {
		const row = rows[i];
		if (row === undefined) {
			break;
		}
		if (row.type !== "context") {
			out.push(row);
			i++;
			continue;
		}
		const start = i;
		while (i < rows.length && rows[i]?.type === "context") {
			i++;
		}
		const run = rows.slice(start, i) as Array<Extract<Row, { type: "context" }>>;
		const isBetweenChangeBlocks = isChangeRow(rows[start - 1]) && isChangeRow(rows[i]);
		if (run.length < collapseAt || !isBetweenChangeBlocks) {
			out.push(...run);
			continue;
		}
		const keep = Math.max(0, edge);
		out.push(...run.slice(0, keep));
		const skipped = run.length - keep * 2;
		if (skipped > 0) {
			out.push({ type: "gap", skipped });
		}
		if (keep > 0) {
			out.push(...run.slice(run.length - keep));
		}
	}
	return out;
}

export function lineNumberWidth(rows: Row[]): number {
	let max = 1;
	for (const row of rows) {
		if (row.type === "context" || row.type === "mod") {
			max = Math.max(max, String(row.oldNum).length, String(row.newNum).length);
		} else if (row.type === "del") {
			max = Math.max(max, String(row.oldNum).length);
		} else if (row.type === "ins") {
			max = Math.max(max, String(row.newNum).length);
		}
	}
	return Math.max(2, max);
}
