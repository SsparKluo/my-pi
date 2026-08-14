/**
 * Strip line/block comments and trailing commas from JSONC.
 * Strings are left intact (// and /* inside quotes are not comments).
 */
export function stripJsonc(input: string): string {
	return stripTrailingCommas(stripComments(input));
}

export function parseJsonc(text: string): unknown {
	return JSON.parse(stripJsonc(text));
}

function stripComments(input: string): string {
	let out = "";
	let i = 0;
	const n = input.length;

	while (i < n) {
		const c = input[i];
		const next = input[i + 1];

		if (c === '"') {
			const scanned = readString(input, i);
			out += scanned.text;
			i = scanned.next;
			continue;
		}

		if (c === "/" && next === "/") {
			i += 2;
			while (i < n && input[i] !== "\n") i += 1;
			continue;
		}

		if (c === "/" && next === "*") {
			i += 2;
			while (i + 1 < n && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
			i += 2;
			continue;
		}

		out += c;
		i += 1;
	}

	return out;
}

function stripTrailingCommas(input: string): string {
	let out = "";
	let i = 0;
	const n = input.length;

	while (i < n) {
		const c = input[i];

		if (c === '"') {
			const scanned = readString(input, i);
			out += scanned.text;
			i = scanned.next;
			continue;
		}

		if (c === ",") {
			let j = i + 1;
			while (j < n && (input[j] === " " || input[j] === "\t" || input[j] === "\n" || input[j] === "\r")) {
				j += 1;
			}
			if (j < n && (input[j] === "}" || input[j] === "]")) {
				i += 1;
				continue;
			}
		}

		out += c;
		i += 1;
	}

	return out;
}

function readString(input: string, start: number): { text: string; next: number } {
	let i = start + 1;
	let text = input[start] ?? "";
	const n = input.length;
	while (i < n) {
		const ch = input[i];
		text += ch;
		if (ch === "\\") {
			if (i + 1 < n) {
				text += input[i + 1];
				i += 2;
				continue;
			}
		} else if (ch === '"') {
			return { text, next: i + 1 };
		}
		i += 1;
	}
	return { text, next: i };
}
