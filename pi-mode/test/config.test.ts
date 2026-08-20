import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfigFromFile, parseConfig } from "../src/config.ts";
import { parseJsonc } from "../src/jsonc.ts";

describe("parseConfig", () => {
	it("fills missing top-level fields from defaults", () => {
		const cfg = parseConfig({});
		expect(cfg.defaultMode).toBe("normal");
		expect(Object.keys(cfg.modes)).toEqual(["normal"]);
		expect(cfg.modes.normal?.permission).toBeUndefined();
		expect(cfg.commandWrappers).toEqual(DEFAULT_CONFIG.commandWrappers);
		expect(cfg.model).toEqual(DEFAULT_CONFIG.model);
		expect(cfg.ask).toEqual(DEFAULT_CONFIG.ask);
	});

	it("treats an empty modes object as unconfigured (vanilla normal)", () => {
		const cfg = parseConfig({ modes: {} });
		expect(Object.keys(cfg.modes)).toEqual(["normal"]);
		expect(cfg.modes.normal?.permission).toBeUndefined();
	});

	it("keeps modes standalone — no inherited rules are injected", () => {
		const cfg = parseConfig({
			modes: {
				normal: { permission: { "*": "ask", read: "allow" } },
				build: { permission: { bash: { "rm *": "ask" }, edit: "ask" } },
			},
		});
		expect(cfg.modes.build?.permission).toEqual({ bash: { "rm *": "ask" }, edit: "ask" });
	});

	it("falls back to normal, then the first mode, when defaultMode names a missing mode", () => {
		const withNormal = parseConfig({ defaultMode: "nromal", modes: { normal: {}, plan: {} } });
		expect(withNormal.defaultMode).toBe("normal");
		const withoutNormal = parseConfig({ defaultMode: "gone", modes: { plan: {}, auto: {} } });
		expect(withoutNormal.defaultMode).toBe("plan");
	});

	it("keeps the internal flag and coerces it to a boolean", () => {
		const cfg = parseConfig({
			modes: { normal: {}, goal: { internal: true }, ghost: { internal: "yes" } },
		});
		expect(cfg.modes.goal?.internal).toBe(true);
		expect(cfg.modes.ghost?.internal).toBe(true);
		expect(cfg.modes.normal?.internal).toBeUndefined();
	});

	it("deep-merges a child's permission over its extends parent", () => {
		const cfg = parseConfig({
			modes: {
				normal: { permission: { "*": "allow", read: "allow", bash: { "*": "ask", ls: "allow" } } },
				plan: { extends: "normal", permission: { write: "deny", bash: { "git push *": "deny" } } },
			},
		});
		expect(cfg.modes.plan?.permission).toEqual({
			"*": "allow",
			read: "allow",
			write: "deny",
			bash: { "*": "ask", ls: "allow", "git push *": "deny" },
		});
	});

	it("resolves extends transitively and keeps prompts per-mode", () => {
		const cfg = parseConfig({
			modes: {
				base: { permission: { "*": "ask" } },
				mid: { extends: "base", permission: { read: "allow" } },
				leaf: { extends: "mid", onEnterPrompt: "hi", permission: { grep: "allow" } },
			},
		});
		expect(cfg.modes.leaf?.permission).toEqual({ "*": "ask", read: "allow", grep: "allow" });
		expect(cfg.modes.leaf?.onEnterPrompt).toBe("hi");
		expect(cfg.modes.mid?.onEnterPrompt).toBeUndefined();
	});

	it("merges classify and model overlays through extends", () => {
		const cfg = parseConfig({
			modes: {
				base: {
					classify: { byRisk: { LOW: "allow" } },
					model: { verdicts: ["allow"], fallback: "ask" },
				},
				child: { extends: "base", classify: { byClass: { DANGEROUS: "model" } } },
			},
		});
		expect(cfg.modes.child?.classify).toEqual({ byRisk: { LOW: "allow" }, byClass: { DANGEROUS: "model" } });
		expect(cfg.modes.child?.model).toEqual({ verdicts: ["allow"], fallback: "ask" });
		});

	it("throws on an extends cycle or unknown parent", () => {
		expect(() => parseConfig({ modes: { a: { extends: "b" }, b: { extends: "a" } } })).toThrow(/cycle/);
		expect(() => parseConfig({ modes: { a: { extends: "a" } } })).toThrow(/cycle/);
		expect(() => parseConfig({ modes: { a: { extends: "ghost" } } })).toThrow(/unknown/);
	});

	it("keeps valid custom actions", () => {
		const cfg = parseConfig({
			modes: {
				strict: {
					permission: {
						"*": "deny",
						read: "allow",
						write: { "*": "ask", "**/*.md": "allow" },
						bash: "classify",
					},
				},
			},
		});
		expect(cfg.modes.strict?.permission).toEqual({
			"*": "deny",
			read: "allow",
			write: { "*": "ask", "**/*.md": "allow" },
			bash: "classify",
		});
	});

	it("coerces unknown actions to deny (fail-closed)", () => {
		const cfg = parseConfig({
			modes: {
				typo: {
					permission: {
						read: "alow",
						write: { "*": "nope", "**/*.md": "allow" },
						bash: "classfy",
					},
				},
			},
		});
		expect(cfg.modes.typo?.permission).toEqual({
			read: "deny",
			write: { "*": "deny", "**/*.md": "allow" },
			bash: "deny",
		});
	});

	it("coerces an invalid classifier fallback to deny", () => {
		const cfg = parseConfig({ model: { fallback: "maybe" } });
		expect(cfg.model.fallback).toBe("deny");
	});

	it("drops unknown classifier verdicts and restores the default set if none remain", () => {
		const kept = parseConfig({ model: { verdicts: ["allow", "nope", "deny"] } });
		expect(kept.model.verdicts).toEqual(["allow", "deny"]);
		const empty = parseConfig({ model: { verdicts: ["nope"] } });
		expect(empty.model.verdicts).toEqual(DEFAULT_CONFIG.model.verdicts);
	});
});

describe("parseJsonc", () => {
	it("strips line comments, block comments, and trailing commas", () => {
		const parsed = parseJsonc(`{
			"defaultMode": "normal", // startup
			"modes": {
				"normal": {},
				/* "plan": {} */
			},
		}`);
		expect(parsed).toEqual({ defaultMode: "normal", modes: { normal: {} } });
	});

	it("does not treat comment markers inside strings as comments", () => {
		const parsed = parseJsonc(`{ "onEnterPrompt": "see http://x.com /* not a comment */" }`);
		expect(parsed).toEqual({ onEnterPrompt: "see http://x.com /* not a comment */" });
	});

	it("ships normal / plan / yolo / auto, with plan and auto extending normal", () => {
		const raw = readFileSync(new URL("../config/config.example.jsonc", import.meta.url), "utf-8");
		const parsed = parseConfig(parseJsonc(raw));
		expect(parsed.defaultMode).toBe("normal");
		expect(Object.keys(parsed.modes)).toEqual(["normal", "plan", "yolo", "auto"]);
		expect(parsed.modes.normal?.permission?.bash).toBe("classify");
		expect(parsed.modes.plan?.internal).toBe(true);
		expect(parsed.modes.plan?.classify?.byClass).toEqual({
			LOCAL_EFFECTS: "ask",
			EXTERNAL_EFFECTS: "ask",
			DANGEROUS: "ask",
			UNKNOWN: "ask",
		});
		expect(parsed.modes.plan?.permission?.edit).toEqual({ "*": "deny", "**/*.md": "allow" });
		// inherited from normal through extends:
		expect(parsed.modes.plan?.permission?.bash).toBe("classify");
		expect(parsed.modes.plan?.permission?.read).toEqual({
			"*": "allow",
			"*.env": "ask",
			"*.env.*": "ask",
			"*.env.example": "allow",
		});
		expect(parsed.modes.auto?.permission?.read).toEqual(parsed.modes.plan?.permission?.read);
		expect(parsed.modes.yolo?.permission).toBeUndefined();
		expect(parsed.modes.auto?.permission?.bash).toEqual({ "*": "classify", rm: "ask", "rm *": "ask" });
		expect(parsed.modes.auto?.permission?.externalPath).toEqual({
			"*": "model",
			"~/.agents/skills/**": "allow",
			"/dev/null": "allow",
			"/tmp/**": "allow",
		});
		expect(parsed.modes.auto?.classify?.byRisk).toEqual({ LOW: "allow", MEDIUM: "model", HIGH: "model" });
		expect(parsed.modes.auto?.model).toEqual({ verdicts: ["allow", "ask"], fallback: "ask" });
		expect(parsed.bashClassify.byClass?.READONLY).toBe("allow");
		expect(parsed.bashClassify.byClass?.EXTERNAL_EFFECTS).toBe("ask");
	});
});

describe("loadConfigFromFile", () => {
	it("creates the commented template when the file is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mode-config-"));
		const path = join(dir, "pi-mode-config.jsonc");
		const result = loadConfigFromFile(path);
		expect(result.created).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.config.defaultMode).toBe("normal");
		expect(Object.keys(result.config.modes)).toEqual(["normal", "plan", "yolo", "auto"]);
		expect(result.config.modes.normal?.permission?.bash).toBe("classify");
		const written = readFileSync(path, "utf-8");
		expect(written).toContain("//");
		expect(written).toContain("READONLY");
	});

	it("loads an existing jsonc file without rewriting it", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mode-config-"));
		const path = join(dir, "pi-mode-config.jsonc");
		writeFileSync(path, `{ "defaultMode": "strict", "modes": { "strict": { "permission": { "*": "deny" } } } }`);
		const result = loadConfigFromFile(path);
		expect(result.created).toBe(false);
		expect(result.config.defaultMode).toBe("strict");
		expect(result.config.modes.strict?.permission).toEqual({ "*": "deny" });
	});
});
