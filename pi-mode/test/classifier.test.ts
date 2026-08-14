import { describe, expect, it } from "vitest";
import {
	buildClassifierUserContent,
	classifyCommands,
	collectAgentsMd,
	lastUserTexts,
	mergeClassifierVerdicts,
	normalizeCacheKey,
	parseClassifierVerdict,
	parseModelRef,
} from "../src/classifier.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const cfg = DEFAULT_CONFIG.classifier;

describe("parseModelRef", () => {
	it("splits provider/id", () => {
		expect(parseModelRef("anthropic/claude-haiku-4-5")).toEqual({
			provider: "anthropic",
			modelId: "claude-haiku-4-5",
		});
		expect(parseModelRef("debug/mock")).toEqual({ provider: "debug", modelId: "mock" });
		expect(parseModelRef("noshift")).toBeNull();
		expect(parseModelRef("/bare")).toBeNull();
	});
});

describe("parseClassifierVerdict", () => {
	const v = ["allow", "deny"];
	it("reads a lone verdict, deny on mixed, fallback on empty", () => {
		expect(parseClassifierVerdict("allow", v, "deny")).toBe("allow");
		expect(parseClassifierVerdict("I would deny this.", v, "allow")).toBe("deny");
		expect(parseClassifierVerdict("allow\ndeny", v, "allow")).toBe("deny");
		expect(parseClassifierVerdict("nope", v, "deny")).toBe("deny");
		expect(parseClassifierVerdict("maybe", v, "allow")).toBe("allow");
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
	it("collects AGENTS.md and the last 3 user texts", () => {
		expect(
			collectAgentsMd([
				{ path: "/proj/AGENTS.md", content: "root" },
				{ path: "/proj/src/notes.md", content: "nope" },
				{ path: "/proj/nested/AGENTS.md", content: "nested" },
			]),
		).toBe("root\n\nnested");
		expect(
			lastUserTexts([
				{ type: "message", message: { role: "assistant", content: "no" } },
				{ type: "message", message: { role: "user", content: "one" } },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "two" }] } },
				{ type: "custom" },
				{ type: "message", message: { role: "user", content: "three" } },
				{ type: "message", message: { role: "user", content: "four" } },
			]),
		).toEqual(["two", "three", "four"]);
	});

	it("builds a prompt that includes agents, history, whole command, and the target", () => {
		const text = buildClassifierUserContent({
			agentsMd: "be careful",
			userMessages: ["run tests"],
			wholeCommand: "ls && rm -rf /",
			target: "rm -rf /",
		});
		expect(text).toContain("## AGENTS.md");
		expect(text).toContain("be careful");
		expect(text).toContain("1. run tests");
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
				userMessages: [],
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
			userMessages: [],
			cache: new Map(),
			complete: async () => {
				throw new Error("offline");
			},
		});
		await expect(boom).resolves.toBe("ask");

		const junk = classifyCommands({
			config: cfg,
			wholeCommand: "ls",
			targets: ["ls"],
			agentsMd: "",
			userMessages: [],
			cache: new Map(),
			complete: async () => "not a verdict",
		});
		await expect(junk).resolves.toBe("ask");
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
			userMessages: [],
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
			userMessages: [],
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
			userMessages: [],
			cache: new Map(),
			complete,
		};
		await classifyCommands(opts);
		await classifyCommands(opts);
		expect(calls).toBe(2);
	});
});
