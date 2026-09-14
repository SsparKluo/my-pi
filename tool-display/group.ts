/** Hang column for group body/footer lines. */
export const GROUP_HANG = 2;
/** Expand affordance on the collapsed group footer. */
export const GROUP_ARROW = "▸";

export type ToolCount = {
	name: string;
	count: number;
};

export type ToolStatus = {
	name: string;
	isError?: boolean;
};

/**
 * Footer for a collapsed group of 2+ tools.
 * `3 tools called: 2 read, 1 bash`
 * Failures are called out per type: all failed `1 bash ✗`, mixed
 * `3 edit (2✓ 1✗)`; clean types stay unmarked.
 * Returns undefined for a single tool (no footer).
 */
export function formatGroupFooter(tools: ToolStatus[]): string | undefined {
	if (tools.length < 2) {
		return undefined;
	}
	const order: string[] = [];
	const byName = new Map<string, { total: number; failed: number }>();
	for (const tool of tools) {
		let entry = byName.get(tool.name);
		if (!entry) {
			entry = { total: 0, failed: 0 };
			byName.set(tool.name, entry);
			order.push(tool.name);
		}
		entry.total += 1;
		if (tool.isError) {
			entry.failed += 1;
		}
	}
	const parts = order.map((name) => {
		const entry = byName.get(name)!;
		if (entry.failed === 0) {
			return `${entry.total} ${name}`;
		}
		const ok = entry.total - entry.failed;
		if (ok === 0) {
			return `${entry.total} ${name} ✗`;
		}
		return `${entry.total} ${name} (${ok}✓ ${entry.failed}✗)`;
	});
	return `${tools.length} tools called: ${parts.join(", ")}`;
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
 *   {pad}▸ {footer}
 * Each member row carries its own status dot; wrapped body lines align
 * under the body column.
 */
export function layoutGroup(options: {
	paddingX: number;
	members: Array<{ dot: string; wrapped: string[] }>;
	footer: string;
	footerGlyph?: string;
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
	const footerGlyph = options.footerGlyph ?? GROUP_ARROW;
	lines.push(`${pad}${footerGlyph} ${options.footer}`);
	return { lines, members, footerY };
}
