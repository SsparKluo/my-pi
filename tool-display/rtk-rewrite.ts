const RTK_REWRITE_MARKER = " · rtk rewritten";

function containsRtkInvocation(command: string): boolean {
	return /(?:^|[;&|]\s*)rtk(?:\s|$)/.test(command.trimStart());
}

export function isRtkRewrite(original: string, actual: string): boolean {
	return (
		original !== actual &&
		!containsRtkInvocation(original) &&
		containsRtkInvocation(actual)
	);
}

export function formatBashTimingLine(
	duration: string,
	when: string,
	isPartial: boolean,
	rtkRewritten: boolean,
	totalLines?: number,
): string {
	const label = isPartial ? "elapsed" : "took";
	let line = `\uF017 ${label} ${duration} · ${when}`;
	if (!isPartial && typeof totalLines === "number") {
		line += ` · ${totalLines} ${totalLines === 1 ? "line" : "lines"}`;
	}
	if (!isPartial && rtkRewritten) {
		line += RTK_REWRITE_MARKER;
	}
	return line;
}
