import { describe, expect, it } from "vitest";
import { evaluateBashCommand } from "../src/bash.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const cwd = "/home/louis/proj";
const plan = DEFAULT_CONFIG.modes.plan?.permission;
const wrappers = DEFAULT_CONFIG.commandWrappers;
const threshold = DEFAULT_CONFIG.classifier.wholeCommandThreshold;

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
		const asked = ev("sudo ls", { bash: "allow" });
		expect(asked.action).toBe("ask");
		expect(asked.subject).toBe("sudo ls");
	});
});

describe("hiding / indirection", () => {
	it("denies hiding units that already match a deny rule", () => {
		expect(ev("sudo rm -rf /").action).toBe("deny");
		expect(ev("bash -c 'rm -rf /'").action).toBe("deny");
	});

	it("asks (fail-closed) when a hiding unit is not denied", () => {
		const open = { bash: "allow" as const };
		expect(ev("sudo ls", open).action).toBe("ask");
		expect(ev("eval ls", open).action).toBe("ask");
		expect(ev("echo $(ls)", open).action).toBe("ask");
		expect(ev("echo `ls`", open).action).toBe("ask");
		expect(ev("find . -exec rm {} +", open).action).toBe("ask");
		expect(ev("for f in *; do echo $f; done", open).action).toBe("ask");
		expect(ev("xargs rm", open).action).toBe("ask");
		expect(ev("sh -c ls", open).action).toBe("ask");
		expect(ev("echo <(ls)", open).action).toBe("ask");
		expect(ev("if true; then ls; fi", open).action).toBe("ask");
	});
});

describe("parse failure and classify threshold", () => {
	it("asks (fail-closed) when unbash reports errors, unless already denied", () => {
		expect(ev("ls &&").action).toBe("ask");
		expect(ev("rm -rf / &&").action).toBe("deny");
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
