import { describe, expect, it } from "vitest";
import {
	buildClassifierUserContent,
	classifyCommands,
	collectAgentsMd,
	conversationWindow,
	mergeClassifierVerdicts,
	normalizeCacheKey,
	parseClassifierVerdict,
} from "../src/classifier.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const cfg = DEFAULT_CONFIG.model;

describe("parseClassifierVerdict", () => {
	const v = ["allow", "deny"];
	it("reads a lone verdict, most restrictive on mixed, fallback on empty", () => {
		expect(parseClassifierVerdict("allow", v, "deny")).toBe("allow");
		expect(parseClassifierVerdict("I would deny this.", v, "allow")).toBe("deny");
		expect(parseClassifierVerdict("allow\ndeny", v, "allow")).toBe("deny");
		expect(parseClassifierVerdict("nope", v, "deny")).toBe("deny");
		expect(parseClassifierVerdict("maybe", v, "allow")).toBe("allow");
	});

	it("picks the most restrictive among the allowed verdicts", () => {
		const ask = ["allow", "ask"];
		expect(parseClassifierVerdict("ask", ask, "deny")).toBe("ask");
		expect(parseClassifierVerdict("allow then ask", ask, "deny")).toBe("ask");
		expect(parseClassifierVerdict("deny", ask, "ask")).toBe("ask");
	});

	it("only accepts ask when it is in the verdict list", () => {
		expect(parseClassifierVerdict("ask", ["allow", "deny", "ask"], "deny")).toBe("ask");
		expect(parseClassifierVerdict("ask", ["allow", "deny"], "deny")).toBe("deny");
	});
});

describe("mergeClassifierVerdicts", () => {
	it("deny wins, all-allow allows, empty uses fallback", () => {
		expect(mergeClassifierVerdicts(["allow", "deny"], "allow")).toBe("deny");
		expect(mergeClassifierVerdicts(["allow", "allow"], "deny")).toBe("allow");
		expect(mergeClassifierVerdicts([], "deny")).toBe("deny");
	});
});

describe("context helpers", () => {
	it("joins every file pi already loaded, without re-filtering names", () => {
		expect(
			collectAgentsMd([
				{ path: "/home/.pi/agent/AGENTS.md", content: "global" },
				{ path: "/proj/CLAUDE.md", content: "project" },
			]),
		).toBe("global\n\nproject");
		expect(collectAgentsMd(undefined)).toBe("");
	});

	it("takes previous user + last assistant text + current user, ignoring the in-progress turn", () => {
		expect(
			conversationWindow([
				{ type: "message", message: { role: "user", content: "older" } },
				{ type: "message", message: { role: "user", content: "previous" } },
				{ type: "message", message: { role: "assistant", content: "tool only" } },
				{ type: "message", message: { role: "assistant", content: "I will push" } },
				{ type: "custom" },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "ok do it" }] } },
				{ type: "message", message: { role: "assistant", content: "running now" } },
			]),
		).toEqual({
			previousUser: "previous",
			previousAssistant: "I will push",
			currentUser: "ok do it",
		});
	});

	it("caps the previous assistant reply from the end", () => {
		const long = "x".repeat(2500);
		const win = conversationWindow([
			{ type: "message", message: { role: "user", content: "a" } },
			{ type: "message", message: { role: "assistant", content: long } },
			{ type: "message", message: { role: "user", content: "b" } },
		]);
		expect(win.previousAssistant).toHaveLength(2000);
		expect(win.previousAssistant).toBe(long.slice(-2000));
	});

	it("builds a prompt that includes agents, conversation, whole command, and the target", () => {
		const text = buildClassifierUserContent({
			agentsMd: "be careful",
			conversation: { currentUser: "run tests" },
			wholeCommand: "ls && rm -rf /",
			target: "rm -rf /",
		});
		expect(text).toContain("## AGENTS.md");
		expect(text).toContain("be careful");
		expect(text).toContain("user: run tests");
		expect(text).toContain("ls && rm -rf /");
		expect(text).toContain("## Classify this");
		expect(text).toContain("rm -rf /");
	});
});

describe("classifyCommands", () => {
	it("caches by normalized command and does not call complete again", async () => {
		const cache = new Map();
		let calls = 0;
		const complete = async () => {
			calls += 1;
			return "allow";
		};
		const run = (target: string) =>
			classifyCommands({
				config: cfg,
				wholeCommand: "ls &&  ls",
				targets: [target],
				agentsMd: "",
				conversation: {},
				cache,
				complete,
			});
		expect(await run("ls")).toBe("allow");
		expect(await run("  ls  ")).toBe("allow");
		expect(calls).toBe(1);
		expect(cache.get(normalizeCacheKey("ls"))).toBe("allow");
	});

	it("falls back when complete throws or the reply is unparseable", async () => {
		const boom = classifyCommands({
			config: cfg,
			wholeCommand: "ls",
			targets: ["ls"],
			agentsMd: "",
			conversation: {},
			cache: new Map(),
			complete: async () => {
				throw new Error("offline");
			},
		});
		await expect(boom).resolves.toBe("deny");

		const junk = classifyCommands({
			config: cfg,
			wholeCommand: "ls",
			targets: ["ls"],
			agentsMd: "",
			conversation: {},
			cache: new Map(),
			complete: async () => "not a verdict",
		});
		await expect(junk).resolves.toBe("deny");
	});

	it("classifies each target and merges deny over allow", async () => {
		const replies = new Map([
			["ls", "allow"],
			["rm foo", "deny"],
		]);
		const action = await classifyCommands({
			config: cfg,
			wholeCommand: "ls && rm foo",
			targets: ["ls", "rm foo"],
			agentsMd: "",
			conversation: {},
			cache: new Map(),
			complete: async (call) => {
				const target = call.userContent.match(/## Classify this\n+([^\n]+)/)?.[1] ?? "";
				return replies.get(target) ?? "??";
			},
		});
		expect(action).toBe("deny");
	});

	it("classifies duplicate targets once in a single call", async () => {
		let calls = 0;
		const action = await classifyCommands({
			config: cfg,
			wholeCommand: "ls && ls",
			targets: ["ls", "  ls  "],
			agentsMd: "",
			conversation: {},
			cache: new Map(),
			complete: async () => {
				calls += 1;
				return "allow";
			},
		});
		expect(action).toBe("allow");
		expect(calls).toBe(1);
	});

	it("skips the cache when cache is disabled", async () => {
		let calls = 0;
		const complete = async () => {
			calls += 1;
			return "allow";
		};
		const opts = {
			config: { ...cfg, cache: false },
			wholeCommand: "ls",
			targets: ["ls"],
			agentsMd: "",
			conversation: {},
			cache: new Map(),
			complete,
		};
		await classifyCommands(opts);
		await classifyCommands(opts);
		expect(calls).toBe(2);
	});
});
