import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
import { minimatch } from "minimatch";
import type { Action, PermissionRules, SurfaceRule } from "./config.ts";

const FILE_SURFACES = new Set(["read", "write", "edit", "grep", "find", "ls", "externalPath"]);

const ACTION_RANK: Record<Action, number> = { deny: 3, ask: 2, classify: 2, allow: 1 };

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
	/** Bash units that resolved to ask — what the dialog shows and session-caches. */
	askUnits?: string[];
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
	if (pattern === "**") return true;
	const expanded = expandHome(pattern);
	if (isAbsolute(expanded)) {
		return minimatch(resolveAbs(subject, cwd), expanded.replace(/\\/g, "/"), MINIMATCH_OPTS);
	}
	const candidates = pathCandidates(subject, cwd);
	if (candidates.length === 0) return false;
	return candidates.some((candidate) => minimatch(candidate, pattern, MINIMATCH_OPTS));
}

function expandHome(pathish: string): string {
	const posix = pathish.replace(/\\/g, "/");
	if (posix === "~" || posix.startsWith("~/")) {
		return join(homedir(), posix.slice(1)).replace(/\\/g, "/");
	}
	return posix;
}

function resolveAbs(subject: string, cwd: string): string {
	const posix = subject.replace(/\\/g, "/").trim();
	if (posix === "~" || posix.startsWith("~/")) {
		return join(homedir(), posix.slice(1)).replace(/\\/g, "/");
	}
	if (isAbsolute(subject)) return normalize(subject).replace(/\\/g, "/");
	return normalize(join(cwd || ".", posix)).replace(/\\/g, "/");
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

const commandGlobCache = new Map<string, RegExp>();

function commandGlobToRegExp(pattern: string): RegExp {
	const hit = commandGlobCache.get(pattern);
	if (hit) return hit;
	let src = "";
	for (const ch of pattern) {
		if (ch === "*") src += ".*";
		else if (ch === "?") src += ".";
		else src += escapeRegex(ch);
	}
	const re = new RegExp(`^${src}$`);
	commandGlobCache.set(pattern, re);
	return re;
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

/**
 * Extra gate for file calls that leave the project.
 * Only runs when `externalPath` is configured; in-project paths are unchanged.
 * Most-restrictive wins against the tool-surface verdict.
 */
export function applyExternalPathGate(
	base: PermissionVerdict,
	rules: PermissionRules | undefined,
	cwd: string,
): PermissionVerdict {
	if (!rules || !Object.hasOwn(rules, "externalPath")) return base;
	if (base.kind !== "path") return base;
	if (!describePath(base.subject, cwd).external) return base;
	const ext = evaluatePermission(rules, "externalPath", base.subject, cwd);
	return (ACTION_RANK[ext.action] ?? 0) > (ACTION_RANK[base.action] ?? 0)
		? { ...ext, surface: base.surface, subject: base.subject, kind: base.kind }
		: base;
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

/**
 * Recompute the active tool set without using the full catalog as a baseline.
 * Candidates are (active ∪ previously-hidden) ∩ catalog. Permission modes
 * hide globally-denied tools; leaving those modes restores only what we hid.
 */
export function reconcileTools(
	rules: PermissionRules | undefined,
	catalog: string[],
	active: string[],
	hidden: string[],
): { active: string[]; hidden: string[] } {
	const known = new Set(catalog);
	const candidate: string[] = [];
	const seen = new Set<string>();
	for (const name of [...active, ...hidden]) {
		if (!known.has(name) || seen.has(name)) continue;
		seen.add(name);
		candidate.push(name);
	}
	if (!rules) {
		return { active: candidate, hidden: [] };
	}
	const next = visibleTools(rules, candidate);
	const nextSet = new Set(next);
	return { active: next, hidden: candidate.filter((name) => !nextSet.has(name)) };
}

export interface SessionApprovalTarget {
	display: string;
	external: boolean;
}

export interface SessionApprovalHint {
	/** Tool / surface name (read, bash, …). */
	tool: string;
	/** Every visible target path, or the raw command when bash has no path args. */
	targets: SessionApprovalTarget[];
}

/** Label bits for the ask-dialog "Allow for session" row. */
export function sessionApprovalHint(verdict: PermissionVerdict, cwd: string): SessionApprovalHint {
	const tool = verdict.surface;
	if (verdict.kind === "path") {
		return { tool, targets: [describePath(verdict.subject, cwd)] };
	}
	if (verdict.kind === "command") {
		const units = verdict.askUnits && verdict.askUnits.length > 0 ? verdict.askUnits : [verdict.subject];
		return {
			tool,
			targets: units.map((unit) => ({ display: unit, external: false })),
		};
	}
	return { tool, targets: [] };
}

/** Resolve a path subject relative to cwd; mark anything that escapes the project as external. */
export function describePath(subject: string, cwd: string): { display: string; external: boolean } {
	const posix = subject.replace(/\\/g, "/").trim();
	if (!posix) return { display: subject, external: false };
	if (posix === "~" || posix.startsWith("~/")) {
		return { display: posix, external: true };
	}
	const abs = isAbsolute(subject) ? normalize(subject) : normalize(join(cwd || ".", posix));
	const absPosix = abs.replace(/\\/g, "/");
	if (!cwd) return { display: absPosix, external: true };
	const rel = relative(cwd, abs).replace(/\\/g, "/");
	const external = !rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel);
	return { display: external ? absPosix : rel, external };
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
