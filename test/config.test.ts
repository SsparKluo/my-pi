import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
	it("fills missing top-level fields from defaults", () => {
		const cfg = parseConfig({});
		expect(cfg.defaultMode).toBe(DEFAULT_CONFIG.defaultMode);
		expect(cfg.commandWrappers).toEqual(DEFAULT_CONFIG.commandWrappers);
		expect(cfg.modes).toEqual(DEFAULT_CONFIG.modes);
		expect(cfg.classifier).toEqual(DEFAULT_CONFIG.classifier);
		expect(cfg.ask).toEqual(DEFAULT_CONFIG.ask);
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
