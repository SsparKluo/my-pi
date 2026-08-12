/**
 * Shared text/diff helpers for tool-display.
 *
 * Adapted from @siddr/pi-tool-display (utils.ts) — MIT, https://github.com/sids/pi-extensions
 * Differences: error-text detection (isLikelyErrorText/isErrorResult) is centralized here
 * instead of living in the extension entry.
 */
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

export type ToolResultContent = {
	type: string;
	text?: string;
};

export type ToolResultLike = {
	content?: ToolResultContent[];
};

export type DiffStats = {
	additions: number;
	removals: number;
	hunks: number;
	files: number;
};

const homePath = homedir();
const noticePattern = /^(.*)\n\n(\[[\s\S]*\])\s*$/s;
const noFilesFoundMessage = "No files found matching pattern";
const noMatchesFoundMessage = "No matches found";
const emptyDirectoryMessage = "(empty directory)";

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function splitLines(text: string): string[] {
	if (text.length === 0) {
		return [];
	}
	return normalizeLineEndings(text).split("\n");
}

export function extractTextContent(result: ToolResultLike | undefined): string {
	if (!result?.content || result.content.length === 0) {
		return "";
	}

	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

export function splitTrailingNoticeBlock(text: string): { body: string; notice?: string } {
	const normalized = normalizeLineEndings(text);
	const match = normalized.match(noticePattern);
	if (!match) {
		return { body: normalized };
	}

	return {
		body: match[1] ?? "",
		notice: match[2] ?? undefined,
	};
}

export function countLines(text: string): number {
	return splitLines(text).length;
}

export function countFindResults(text: string): number {
	const { body } = splitTrailingNoticeBlock(text);
	if (body.trim().length === 0 || body.trim() === noFilesFoundMessage) {
		return 0;
	}
	return splitLines(body).filter((line) => line.length > 0).length;
}

export function countLsEntries(text: string): number {
	const { body } = splitTrailingNoticeBlock(text);
	if (body.trim().length === 0 || body.trim() === emptyDirectoryMessage) {
		return 0;
	}
	return splitLines(body).filter((line) => line.length > 0).length;
}

export function countGrepMatches(text: string): number {
	const { body } = splitTrailingNoticeBlock(text);
	if (body.trim().length === 0 || body.trim() === noMatchesFoundMessage) {
		return 0;
	}
	return splitLines(body).filter((line) => /:\d+:\s/.test(line)).length;
}

/** Count matches in @ff-labs/pi-fff ffgrep output (` N: content` lines). */
export function countFffGrepMatches(text: string): number {
	const { body } = splitTrailingNoticeBlock(text);
	if (body.trim().length === 0 || body.trim() === noMatchesFoundMessage) {
		return 0;
	}
	return splitLines(body).filter((line) => /^\s*\d+:\s/.test(line)).length;
}

/** Count file hits in @ff-labs/pi-fff fffind output (one path per line). */
export function countFffFindResults(text: string): number {
	const { body } = splitTrailingNoticeBlock(text);
	if (body.trim().length === 0 || body.trim() === noFilesFoundMessage) {
		return 0;
	}
	return splitLines(body).filter((line) => line.length > 0).length;
}

export function formatDisplayPath(
	filePath: string,
	options: {
		offset?: number;
		limit?: number;
	} = {},
): string {
	let displayPath = filePath;

	if (isAbsolute(filePath) && (filePath === homePath || filePath.startsWith(`${homePath}/`))) {
		displayPath = `~${filePath.slice(homePath.length)}`;
	}

	if (options.offset !== undefined || options.limit !== undefined) {
		const startLine = options.offset ?? 1;
		const endLine = options.limit !== undefined ? startLine + options.limit - 1 : undefined;
		displayPath += `:${startLine}${endLine !== undefined ? `-${endLine}` : "-"}`;
	}

	return displayPath;
}

export function getDiffStats(diff: string): DiffStats {
	let additions = 0;
	let removals = 0;
	let explicitHunks = 0;
	let inferredHunks = 0;
	let inChangeGroup = false;

	for (const line of splitLines(diff)) {
		if (line.startsWith("@@")) {
			explicitHunks += 1;
			inChangeGroup = false;
			continue;
		}
		if (line.startsWith("+++") || line.startsWith("---")) {
			inChangeGroup = false;
			continue;
		}
		if (line.startsWith("+")) {
			additions += 1;
			if (!inChangeGroup) {
				inferredHunks += 1;
				inChangeGroup = true;
			}
			continue;
		}
		if (line.startsWith("-")) {
			removals += 1;
			if (!inChangeGroup) {
				inferredHunks += 1;
				inChangeGroup = true;
			}
			continue;
		}

		inChangeGroup = false;
	}

	const hunks = explicitHunks > 0 ? explicitHunks : inferredHunks;
	return {
		additions,
		removals,
		hunks,
		files: 1,
	};
}

/** Heuristic: does this stdout/stderr text look like a tool error? Mirrors pi's built-in phrasing. */
export function isLikelyErrorText(text: string): boolean {
	if (text.length === 0) {
		return false;
	}

	return (
		text.startsWith("Error") ||
		text.startsWith("Operation aborted") ||
		text.startsWith("Path not found:") ||
		text.startsWith("Not a directory:") ||
		text.startsWith("Cannot read directory:") ||
		text.startsWith("File not found:") ||
		text.startsWith("Offset ") ||
		text.startsWith("Working directory does not exist:") ||
		text.startsWith("Failed to run ") ||
		text.startsWith("fd is not available") ||
		text.startsWith("ripgrep (rg) is not available") ||
		text.endsWith("Command aborted") ||
		/Command timed out after \d+ seconds\s*$/.test(text) ||
		/Command exited with code \d+\s*$/.test(text)
	);
}

export function isErrorResult(result: unknown, text: string): boolean {
	if (typeof result === "object" && result !== null && "isError" in result) {
		if ((result as { isError?: unknown }).isError === true) {
			return true;
		}
	}
	return isLikelyErrorText(text);
}
