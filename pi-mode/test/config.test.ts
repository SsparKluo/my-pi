import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfigFromFile, parseConfig } from "../src/config.ts";
import { parseJsonc } from "../src/jsonc.ts";

describe("parseConfig", () => {
	it("fills missing top-level fields from defaults", () => {
		const cfg = parseConfig({});
		expect(cfg.defaultMode).toBe("default");
		expect(Object.keys(cfg.modes)).toEqual(["default"]);
		expect(cfg.modes.default?.permission).toBeUndefined();
		expect(cfg.commandWrappers).toEqual(DEFAULT_CONFIG.commandWrappers);
		expect(cfg.classifier).toEqual(DEFAULT_CONFIG.classifier);
		expect(cfg.ask).toEqual(DEFAULT_CONFIG.ask);
	});

	it("treats an empty modes object as unconfigured (vanilla default)", () => {
		const cfg = parseConfig({ modes: {} });
		expect(Object.keys(cfg.modes)).toEqual(["default"]);
		expect(cfg.modes.default?.permission).toBeUndefined();
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
		const cfg = parseConfig({ classifier: { fallback: "maybe" } });
		expect(cfg.classifier.fallback).toBe("deny");
	});

	it("drops unknown classifier verdicts and restores the default set if none remain", () => {
		const kept = parseConfig({ classifier: { verdicts: ["allow", "nope", "deny"] } });
		expect(kept.classifier.verdicts).toEqual(["allow", "deny"]);
		const empty = parseConfig({ classifier: { verdicts: ["nope"] } });
		expect(empty.classifier.verdicts).toEqual(DEFAULT_CONFIG.classifier.verdicts);
	});
});

describe("parseJsonc", () => {
	it("strips line comments, block comments, and trailing commas", () => {
		const parsed = parseJsonc(`{
			"defaultMode": "default", // startup
			"modes": {
				"default": {},
				/* "plan": {} */
			},
		}`);
		expect(parsed).toEqual({ defaultMode: "default", modes: { default: {} } });
	});

	it("does not treat comment markers inside strings as comments", () => {
		const parsed = parseJsonc(`{ "onEnterPrompt": "see http://x.com /* not a comment */" }`);
		expect(parsed).toEqual({ onEnterPrompt: "see http://x.com /* not a comment */" });
	});

	it("parses the shipped example as default-only", () => {
		const raw = readFileSync(new URL("../config/config.example.jsonc", import.meta.url), "utf-8");
		const parsed = parseConfig(parseJsonc(raw));
		expect(parsed.defaultMode).toBe("default");
		expect(Object.keys(parsed.modes)).toEqual(["default"]);
		expect(parsed.modes.default?.permission).toBeUndefined();
	});
});

describe("loadConfigFromFile", () => {
	it("creates the commented template when the file is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mode-config-"));
		const path = join(dir, "pi-mode-config.jsonc");
		const result = loadConfigFromFile(path);
		expect(result.created).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.config.defaultMode).toBe("default");
		expect(Object.keys(result.config.modes)).toEqual(["default"]);
		expect(result.config.modes.default?.permission).toBeUndefined();
		const written = readFileSync(path, "utf-8");
		expect(written).toContain("//");
		expect(written).toContain("plan");
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
