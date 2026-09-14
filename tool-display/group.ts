/** Hang column for group body/footer lines. */
export const GROUP_HANG = 2;

export type ToolCount = {
	name: string;
	count: number;
};

/** Counts tool names in first-seen order. */
export function countByAppearance(names: string[]): ToolCount[] {
	const order: string[] = [];
	const counts = new Map<string, number>();
	for (const name of names) {
		if (!counts.has(name)) {
			order.push(name);
		}
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return order.map((name) => ({ name, count: counts.get(name) ?? 0 }));
}

/**
 * Footer for a collapsed group of 2+ tools.
 * `3 tools called: 2 read, 1 bash`
 * Returns undefined for a single tool (no footer).
 */
export function formatGroupFooter(names: string[]): string | undefined {
	if (names.length < 2) {
		return undefined;
	}
	const parts = countByAppearance(names).map((entry) => `${entry.count} ${entry.name}`);
	return `${names.length} tools called: ${parts.join(", ")}`;
}

function skipAnsi(line: string, index: number): number {
	if (line.charCodeAt(index) !== 0x1b) {
		return index;
	}
	let i = index + 1;
	if (i < line.length && line[i] === "[") {
		i += 1;
		while (i < line.length && line[i] !== "m") {
			i += 1;
		}
		if (i < line.length) {
			i += 1;
		}
	}
	return i;
}

/** Drop leading pad + `● ` (ANSI-safe) from a call chrome line. */
export function stripLeadingCallChrome(line: string): string {
	let i = 0;
	let seenDot = false;
	while (i < line.length) {
		if (line.charCodeAt(i) === 0x1b) {
			i = skipAnsi(line, i);
			continue;
		}
		if (!seenDot) {
			if (line[i] === " " || line[i] === "\t") {
				i += 1;
				continue;
			}
			if (line[i] === "●") {
				seenDot = true;
				i += 1;
				continue;
			}
			return line.slice(i);
		}
		if (line[i] === " ") {
			i += 1;
		}
		return line.slice(i);
	}
	return "";
}

/** Drop `hangCols` leading spaces (ANSI-safe) from a hanging result line. */
export function stripHangPad(line: string, hangCols: number): string {
	let cols = 0;
	let i = 0;
	while (i < line.length && cols < hangCols) {
		if (line.charCodeAt(i) === 0x1b) {
			i = skipAnsi(line, i);
			continue;
		}
		if (line[i] === " ") {
			cols += 1;
			i += 1;
			continue;
		}
		break;
	}
	return line.slice(i);
}

export function joinCompactLine(callBody: string, summary: string | undefined, separator: string): string {
	if (!summary) {
		return callBody;
	}
	if (!callBody) {
		return summary;
	}
	return `${callBody} ${separator} ${summary}`;
}

export type GroupMemberLayout = {
	/** First line y (0-based within the group block, excluding a leading blank). */
	y: number;
	height: number;
};

export type GroupLayout = {
	lines: string[];
	members: GroupMemberLayout[];
	footerY: number;
};

let compactSummaryMode = false;

export function isCompactSummary(): boolean {
	return compactSummaryMode;
}

export function withCompactSummary<T>(fn: () => T): T {
	compactSummaryMode = true;
	try {
		return fn();
	} finally {
		compactSummaryMode = false;
	}
}

/**
 * Lay out a collapsed group (no rail column):
 *   {pad}● {first}
 *   {pad}● {rest…}
 *   {pad}  {footer}
 * Each member row carries its own status dot; wrapped body lines align
 * under the body column.
 */
export function layoutGroup(options: {
	paddingX: number;
	members: Array<{ dot: string; wrapped: string[] }>;
	footer: string;
}): GroupLayout {
	const pad = " ".repeat(Math.max(0, options.paddingX));
	const hang = " ".repeat(GROUP_HANG);
	const lines: string[] = [];
	const members: GroupMemberLayout[] = [];

	for (let i = 0; i < options.members.length; i++) {
		const member = options.members[i] ?? { dot: "", wrapped: [] };
		const wrapped = member.wrapped.length > 0 ? member.wrapped : [""];
		const y = lines.length;
		for (let row = 0; row < wrapped.length; row++) {
			const body = wrapped[row] ?? "";
			const prefix = row === 0 ? `${pad}${member.dot} ` : `${pad}${hang}`;
			lines.push(body.length > 0 ? `${prefix}${body}` : prefix.trimEnd());
		}
		members.push({ y, height: Math.max(wrapped.length, 1) });
	}

	const footerY = lines.length;
	lines.push(`${pad}${hang}${options.footer}`);
	return { lines, members, footerY };
}
