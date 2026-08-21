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
): string {
	const label = isPartial ? "elapsed" : "took";
	const rewriteMarker = !isPartial && rtkRewritten ? RTK_REWRITE_MARKER : "";
	return `\uF017 ${label} ${duration} · ${when}${rewriteMarker}`;
}
