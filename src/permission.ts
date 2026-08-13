import { isAbsolute, normalize, relative } from "node:path";
import { minimatch } from "minimatch";
import type { Action, PermissionRules, SurfaceRule } from "./config.ts";

const FILE_SURFACES = new Set(["read", "write", "edit", "grep", "find", "ls", "path"]);

const MINIMATCH_OPTS = { dot: true, nocomment: true } as const;

export type MatchKind = "path" | "command" | "tool";

export interface PermissionVerdict {
	action: Action;
	surface: string;
	/** Last matching pattern, or `"*"` for a whole-surface string rule. */
	pattern: string | null;
	subject: string;
	kind: MatchKind;
	/** Set when action is classify: units to send, or the whole command. */
	classifyTargets?: string[];
}

export function subjectKind(surface: string): MatchKind {
	if (surface === "bash") return "command";
	if (FILE_SURFACES.has(surface)) return "path";
	return "tool";
}

/** Pull the path/command the rules should match against. */
export function extractSubject(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" && typeof input.command === "string") return input.command;
	if (typeof input.path === "string" && input.path.length > 0) return input.path;
	return toolName;
}

export function patternMatches(pattern: string, subject: string, kind: MatchKind, cwd: string): boolean {
	if (pattern === "*") return true;
	if (kind === "path") return matchPath(subject, pattern, cwd);
	if (kind === "command") return matchCommand(subject, pattern);
	return matchCommand(subject, pattern);
}

/** Path globs via minimatch. `*` is match-all (see patternMatches). Nested markdown globs match top-level files too. */
function matchPath(subject: string, pattern: string, cwd: string): boolean {
	const candidates = pathCandidates(subject, cwd);
	if (candidates.length === 0) return false;
	if (pattern === "**") return true;
	return candidates.some((candidate) => minimatch(candidate, pattern, MINIMATCH_OPTS));
}

/** Cwd-relative forms only. Paths that escape the project produce no candidates (fail-closed). */
function pathCandidates(subject: string, cwd: string): string[] {
	const posix = subject.replace(/\\/g, "/");
	let rel: string;
	if (isAbsolute(subject)) {
		if (!cwd) return [];
		rel = relative(cwd, subject).replace(/\\/g, "/");
	} else {
		const stripped = posix.startsWith("./") ? posix.slice(2) : posix;
		rel = normalize(stripped).replace(/\\/g, "/");
	}
	if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
		return [];
	}
	return [rel];
}

/** Command-prefix glob: `*` / `?` match any chars including spaces and slashes. */
function matchCommand(subject: string, pattern: string): boolean {
	return commandGlobToRegExp(pattern).test(subject);
}

function commandGlobToRegExp(pattern: string): RegExp {
	let src = "";
	for (const ch of pattern) {
		if (ch === "*") src += ".*";
		else if (ch === "?") src += ".";
		else src += escapeRegex(ch);
	}
	return new RegExp(`^${src}$`);
}

function escapeRegex(ch: string): string {
	return ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function resolveRule(rules: PermissionRules, surface: string): SurfaceRule | undefined {
	if (Object.hasOwn(rules, surface)) return rules[surface];
	return rules["*"];
}

/**
 * Last-match-wins. No permission block → allow (prompt-only mode).
 * No matching pattern → deny (fail-closed).
 */
export function evaluatePermission(
	rules: PermissionRules | undefined,
	surface: string,
	subject: string,
	cwd: string,
): PermissionVerdict {
	const kind = subjectKind(surface);
	if (!rules) {
		return { action: "allow", surface, pattern: null, subject, kind };
	}
	const rule = resolveRule(rules, surface);
	if (rule === undefined) {
		return { action: "deny", surface, pattern: null, subject, kind };
	}
	if (typeof rule === "string") {
		return { action: rule, surface, pattern: "*", subject, kind };
	}
	let hit: { pattern: string; action: Action } | undefined;
	for (const [pattern, action] of Object.entries(rule)) {
		if (patternMatches(pattern, subject, kind, cwd)) {
			hit = { pattern, action };
		}
	}
	if (!hit) {
		return { action: "deny", surface, pattern: null, subject, kind };
	}
	return { action: hit.action, surface, pattern: hit.pattern, subject, kind };
}

/** True when every possible call on this surface is deny (hide the tool). */
export function isSurfaceGloballyDenied(rules: PermissionRules | undefined, surface: string): boolean {
	if (!rules) return false;
	const rule = resolveRule(rules, surface);
	if (rule === undefined) return true;
	if (typeof rule === "string") return rule === "deny";
	const actions = Object.values(rule);
	if (actions.length === 0) return true;
	return actions.every((action) => action === "deny");
}

export function visibleTools(rules: PermissionRules | undefined, toolNames: string[]): string[] {
	if (!rules) return toolNames;
	return toolNames.filter((name) => !isSurfaceGloballyDenied(rules, name));
}

export class SessionApprovals {
	private readonly entries: { surface: string; pattern: string }[] = [];

	add(surface: string, pattern: string): void {
		if (this.entries.some((e) => e.surface === surface && e.pattern === pattern)) return;
		this.entries.push({ surface, pattern });
	}

	allows(surface: string, subject: string, kind: MatchKind, cwd: string): boolean {
		return this.entries.some((e) => e.surface === surface && patternMatches(e.pattern, subject, kind, cwd));
	}

	clear(): void {
		this.entries.length = 0;
	}
}
