import { describe, expect, it } from "vitest";
import { PLAN_PERMISSION } from "./plan-permission.ts";
import {
	applyExternalPathGate,
	evaluatePermission,
	describePath,
	extractSubject,
	isSurfaceGloballyDenied,
	patternMatches,
	reconcileTools,
	sessionApprovalHint,
	SessionApprovals,
	visibleTools,
} from "../src/permission.ts";

const cwd = "/home/louis/proj";
const plan = PLAN_PERMISSION;

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

	it("matches ./prefixed subjects against the stripped relative path", () => {
		expect(patternMatches("**/*.md", "./README.md", "path", cwd)).toBe(true);
		expect(patternMatches("*.md", "./README.md", "path", cwd)).toBe(true);
	});

	it("does not let * cross / (minimatch semantics, no basename fallback)", () => {
		expect(patternMatches("*.md", "src/foo.md", "path", cwd)).toBe(false);
		expect(patternMatches("*.md", "foo.md", "path", cwd)).toBe(true);
	});

	it("does not match paths that escape cwd", () => {
		expect(patternMatches("**/*.md", "../secrets.md", "path", cwd)).toBe(false);
		expect(patternMatches("**/*.md", "../../etc/passwd.md", "path", cwd)).toBe(false);
		expect(patternMatches("**/*.md", "/etc/evil.md", "path", cwd)).toBe(false);
		expect(patternMatches("**/*.md", `${cwd}/../outside.md`, "path", cwd)).toBe(false);
	});

	it("matches ~ and absolute globs against external paths", () => {
		expect(patternMatches("~/.agents/skills/*", `${process.env.HOME}/.agents/skills/foo`, "path", cwd)).toBe(
			true,
		);
		expect(patternMatches("~/.agents/skills/**", "~/.agents/skills/foo/bar", "path", cwd)).toBe(true);
		expect(patternMatches("/tmp/**", "/tmp/out/file.ts", "path", cwd)).toBe(true);
		expect(patternMatches("~/.agents/skills/*", "/etc/passwd", "path", cwd)).toBe(false);
	});

	it("still matches in-project paths after collapsing . and ..", () => {
		expect(patternMatches("**/*.md", "docs/../README.md", "path", cwd)).toBe(true);
		expect(patternMatches("*.md", "docs/../README.md", "path", cwd)).toBe(true);
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

describe("applyExternalPathGate", () => {
	const rules = {
		read: "allow" as const,
		externalPath: {
			"*": "ask" as const,
			"~/.agents/skills/**": "allow" as const,
		},
	};

	it("does not change in-project file calls", () => {
		const base = evaluatePermission(rules, "read", "src/a.ts", cwd);
		expect(applyExternalPathGate(base, rules, cwd).action).toBe("allow");
	});

	it("asks for an external path when externalPath says ask", () => {
		const base = evaluatePermission(rules, "read", "/etc/passwd", cwd);
		expect(base.action).toBe("allow");
		expect(applyExternalPathGate(base, rules, cwd).action).toBe("ask");
	});

	it("allows a configured external directory", () => {
		const subject = `${process.env.HOME}/.agents/skills/foo`;
		const base = evaluatePermission(rules, "read", subject, cwd);
		expect(applyExternalPathGate(base, rules, cwd).action).toBe("allow");
	});

	it("is a no-op when externalPath is not configured", () => {
		const onlyRead = { read: "allow" as const };
		const base = evaluatePermission(onlyRead, "read", "/etc/passwd", cwd);
		expect(applyExternalPathGate(base, onlyRead, cwd).action).toBe("allow");
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

	it("denies plan writes that escape the project, even if the basename is .md", () => {
		expect(evaluatePermission(plan, "write", "../secrets.md", cwd).action).toBe("deny");
		expect(evaluatePermission(plan, "write", "/etc/evil.md", cwd).action).toBe("deny");
		expect(evaluatePermission(plan, "write", "../../etc/passwd.md", cwd).action).toBe("deny");
		expect(evaluatePermission(plan, "edit", `${cwd}/../outside.md`, cwd).action).toBe("deny");
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

	it("does not pull disabled catalog tools back when entering a permission mode", () => {
		const next = reconcileTools({ write: "deny", "*": "allow" }, ["read", "write", "bash"], ["read", "bash"], []);
		expect(next.active).toEqual(["read", "bash"]);
		expect(next.hidden).toEqual([]);
	});

	it("hides a newly-active globally-denied tool and restores only what we hid", () => {
		const denied = reconcileTools(
			{ write: "deny", "*": "allow" },
			["read", "write", "bash"],
			["read", "write", "bash"],
			[],
		);
		expect(denied.active).toEqual(["read", "bash"]);
		expect(denied.hidden).toEqual(["write"]);

		const restored = reconcileTools(undefined, ["read", "write", "bash"], denied.active, denied.hidden);
		expect(restored.active).toEqual(["read", "bash", "write"]);
		expect(restored.hidden).toEqual([]);
	});

	it("drops tools that left the catalog and keeps user-disabled tools disabled", () => {
		const next = reconcileTools(undefined, ["read", "write"], ["read"], ["write", "gone"]);
		expect(next.active).toEqual(["read", "write"]);
		expect(next.hidden).toEqual([]);
	});
});

describe("extractSubject", () => {
	it("reads command / path fields", () => {
		expect(extractSubject("bash", { command: "ls -la" })).toBe("ls -la");
		expect(extractSubject("write", { path: "src/a.ts", content: "x" })).toBe("src/a.ts");
		expect(extractSubject("ls", {})).toBe("ls");
	});
});

describe("sessionApprovalHint", () => {
	it("shows the tool and a project-relative path for in-repo file calls", () => {
		const hint = sessionApprovalHint(
			{ action: "ask", surface: "read", pattern: "*", subject: `${cwd}/src/a.ts`, kind: "path" },
			cwd,
		);
		expect(hint).toEqual({ tool: "read", targets: [{ display: "src/a.ts", external: false }] });
	});

	it("flags paths that escape cwd as external and keeps the absolute target", () => {
		expect(describePath("/etc/passwd", cwd)).toEqual({ display: "/etc/passwd", external: true });
		expect(describePath("../secrets", cwd)).toEqual({ display: "/home/louis/secrets", external: true });
		expect(describePath("~/notes.md", cwd)).toEqual({ display: "~/notes.md", external: true });
		const hint = sessionApprovalHint(
			{ action: "ask", surface: "read", pattern: "*", subject: "/tmp/out/file.ts", kind: "path" },
			cwd,
		);
		expect(hint).toEqual({
			tool: "read",
			targets: [{ display: "/tmp/out/file.ts", external: true }],
		});
	});

	it("lists every unbash ask unit without external flagging (bash is not path-gated)", () => {
		const hint = sessionApprovalHint(
			{
				action: "ask",
				surface: "bash",
				pattern: "*",
				subject: "ls && git push origin && sudo cat /etc/hosts",
				kind: "command",
				askUnits: ["git push origin", "sudo cat /etc/hosts"],
			},
			cwd,
		);
		expect(hint).toEqual({
			tool: "bash",
			targets: [
				{ display: "git push origin", external: false },
				{ display: "sudo cat /etc/hosts", external: false },
			],
		});
	});

	it("falls back to the raw command when no ask units were recorded", () => {
		const hint = sessionApprovalHint(
			{ action: "ask", surface: "bash", pattern: "ls", subject: "ls -la", kind: "command" },
			cwd,
		);
		expect(hint).toEqual({ tool: "bash", targets: [{ display: "ls -la", external: false }] });
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

	it("session-caches exact bash ask units so a later compound command can reuse them", () => {
		const store = new SessionApprovals();
		store.add("bash", "git push origin");
		expect(store.allows("bash", "git push origin", "command", cwd)).toBe(true);
		expect(store.allows("bash", "git push origin main", "command", cwd)).toBe(false);
	});

	it("treats * as the whole surface and can be cleared", () => {
		const store = new SessionApprovals();
		store.add("bash", "*");
		expect(store.allows("bash", "anything", "command", cwd)).toBe(true);
		store.clear();
		expect(store.allows("bash", "anything", "command", cwd)).toBe(false);
	});
});
