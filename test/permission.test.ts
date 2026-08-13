import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	evaluatePermission,
	extractSubject,
	isSurfaceGloballyDenied,
	patternMatches,
	SessionApprovals,
	visibleTools,
} from "../src/permission.ts";

const cwd = "/home/louis/proj";
const plan = DEFAULT_CONFIG.modes.plan?.permission;

describe("path globs", () => {
	it("treats * as match-all, including nested paths", () => {
		expect(patternMatches("*", "src/foo.ts", "path", cwd)).toBe(true);
		expect(patternMatches("*", "foo.ts", "path", cwd)).toBe(true);
	});

	it("matches **/*.md at repo root and in subdirs", () => {
		expect(patternMatches("**/*.md", "foo.md", "path", cwd)).toBe(true);
		expect(patternMatches("**/*.md", "README.md", "path", cwd)).toBe(true);
		expect(patternMatches("**/*.md", "docs/plan.md", "path", cwd)).toBe(true);
		expect(patternMatches("**/*.md", "src/foo.ts", "path", cwd)).toBe(false);
	});

	it("matches absolute paths against **/*.md via cwd-relative form", () => {
		expect(patternMatches("**/*.md", `${cwd}/README.md`, "path", cwd)).toBe(true);
		expect(patternMatches("**/*.md", `${cwd}/src/index.ts`, "path", cwd)).toBe(false);
	});

	it("matches ./prefixed and basename-only subjects", () => {
		expect(patternMatches("**/*.md", "./README.md", "path", cwd)).toBe(true);
		expect(patternMatches("*.md", "src/foo.md", "path", cwd)).toBe(true);
	});
});

describe("command globs", () => {
	it("matches exact tokens and starred args, including slashes", () => {
		expect(patternMatches("ls", "ls", "command", cwd)).toBe(true);
		expect(patternMatches("ls", "ls -la", "command", cwd)).toBe(false);
		expect(patternMatches("ls *", "ls -la", "command", cwd)).toBe(true);
		expect(patternMatches("cat *", "cat src/index.ts", "command", cwd)).toBe(true);
		expect(patternMatches("git status", "git status", "command", cwd)).toBe(true);
		expect(patternMatches("git status", "git status -sb", "command", cwd)).toBe(false);
		expect(patternMatches("git diff *", "git diff HEAD", "command", cwd)).toBe(true);
	});
});

describe("evaluatePermission", () => {
	it("allows everything when the mode has no permission block", () => {
		const v = evaluatePermission(undefined, "write", "src/a.ts", cwd);
		expect(v.action).toBe("allow");
	});

	it("uses last-match-wins so plan can write markdown only", () => {
		expect(evaluatePermission(plan, "write", "README.md", cwd).action).toBe("allow");
		expect(evaluatePermission(plan, "write", "docs/plan.md", cwd).action).toBe("allow");
		expect(evaluatePermission(plan, "write", "src/index.ts", cwd).action).toBe("deny");
		expect(evaluatePermission(plan, "edit", `${cwd}/notes.md`, cwd).action).toBe("allow");
		expect(evaluatePermission(plan, "edit", `${cwd}/src/index.ts`, cwd).action).toBe("deny");
	});

	it("allows plan's read-only bash allowlist and denies the rest", () => {
		expect(evaluatePermission(plan, "bash", "ls", cwd).action).toBe("allow");
		expect(evaluatePermission(plan, "bash", "git status", cwd).action).toBe("allow");
		expect(evaluatePermission(plan, "bash", "cat src/index.ts", cwd).action).toBe("allow");
		expect(evaluatePermission(plan, "bash", "rm -rf /", cwd).action).toBe("deny");
		expect(evaluatePermission(plan, "bash", "git push origin main", cwd).action).toBe("deny");
	});

	it("falls through to * for unknown tools (plan → ask)", () => {
		const v = evaluatePermission(plan, "questionnaire", "questionnaire", cwd);
		expect(v.action).toBe("ask");
		expect(v.pattern).toBe("*");
	});

	it("records the matched pattern for session-approval", () => {
		const v = evaluatePermission(plan, "bash", "git log --oneline", cwd);
		expect(v.action).toBe("allow");
		expect(v.pattern).toBe("git log *");
	});

	it("fails closed when a pattern map matches nothing", () => {
		const v = evaluatePermission({ write: { "**/*.md": "allow" } }, "write", "src/a.ts", cwd);
		expect(v.action).toBe("deny");
		expect(v.pattern).toBeNull();
	});

	it("last-match-wins: later allow overrides earlier deny, and vice versa", () => {
		const allowLast = { write: { "*": "deny" as const, "**/*.md": "allow" as const } };
		const denyLast = { write: { "**/*.md": "allow" as const, "*": "deny" as const } };
		expect(evaluatePermission(allowLast, "write", "README.md", cwd).action).toBe("allow");
		expect(evaluatePermission(denyLast, "write", "README.md", cwd).action).toBe("deny");
	});

	it("uses a string rule for the whole surface", () => {
		const v = evaluatePermission({ write: "deny" }, "write", "README.md", cwd);
		expect(v.action).toBe("deny");
		expect(v.pattern).toBe("*");
	});

	it("falls back to * when the surface has no key, and denies when neither exists", () => {
		expect(evaluatePermission({ "*": "ask" }, "write", "src/a.ts", cwd).action).toBe("ask");
		expect(evaluatePermission({ read: "allow" }, "write", "src/a.ts", cwd).action).toBe("deny");
	});

	it("passes classify through as a first-class action", () => {
		expect(evaluatePermission({ bash: "classify" }, "bash", "ls", cwd).action).toBe("classify");
	});
});

describe("tool hiding", () => {
	it("does not hide write/edit/bash in plan (they have allow paths)", () => {
		expect(isSurfaceGloballyDenied(plan, "write")).toBe(false);
		expect(isSurfaceGloballyDenied(plan, "edit")).toBe(false);
		expect(isSurfaceGloballyDenied(plan, "bash")).toBe(false);
		expect(isSurfaceGloballyDenied(plan, "read")).toBe(false);
	});

	it("hides a surface whose rule is a bare deny", () => {
		expect(isSurfaceGloballyDenied({ write: "deny", "*": "allow" }, "write")).toBe(true);
		expect(visibleTools({ write: "deny", "*": "allow" }, ["read", "write", "bash"])).toEqual(["read", "bash"]);
	});

	it("hides a surface with no rule and no * fallback", () => {
		expect(isSurfaceGloballyDenied({ read: "allow" }, "write")).toBe(true);
	});

	it("leaves tools untouched when the mode has no permission block", () => {
		expect(visibleTools(undefined, ["read", "write"])).toEqual(["read", "write"]);
	});
});

describe("extractSubject", () => {
	it("reads command / path fields", () => {
		expect(extractSubject("bash", { command: "ls -la" })).toBe("ls -la");
		expect(extractSubject("write", { path: "src/a.ts", content: "x" })).toBe("src/a.ts");
		expect(extractSubject("ls", {})).toBe("ls");
	});
});

describe("SessionApprovals", () => {
	it("re-allows later calls that match the recorded pattern", () => {
		const store = new SessionApprovals();
		store.add("bash", "git push *");
		expect(store.allows("bash", "git push origin main", "command", cwd)).toBe(true);
		expect(store.allows("bash", "git status", "command", cwd)).toBe(false);
		expect(store.allows("write", "git push origin main", "path", cwd)).toBe(false);
	});

	it("treats * as the whole surface and can be cleared", () => {
		const store = new SessionApprovals();
		store.add("bash", "*");
		expect(store.allows("bash", "anything", "command", cwd)).toBe(true);
		store.clear();
		expect(store.allows("bash", "anything", "command", cwd)).toBe(false);
	});
});
