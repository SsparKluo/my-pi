import { describe, expect, it } from "vitest";
import {
	classifyBashCommands,
	mapBashClassifyAction,
	mergeClassifyMaps,
	parseBashClassifyJson,
} from "../src/bash-classify.ts";
import { evaluateBashCommand } from "../src/bash.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const cwd = "/tmp/proj";
const wrappers = DEFAULT_CONFIG.commandWrappers;

describe("mapBashClassifyAction", () => {
	it("lets byClass defer to the model", () => {
		expect(
			mapBashClassifyAction(
				{ classification: "EXTERNAL_EFFECTS", risk: "MEDIUM" },
				{ byClass: { EXTERNAL_EFFECTS: "model" } },
			),
		).toBe("model");
	});

	it("uses byClass when the classification is listed", () => {
		expect(
			mapBashClassifyAction(
				{ classification: "READONLY", risk: "LOW" },
				{ byClass: { READONLY: "allow" }, byRisk: { LOW: "ask" } },
			),
		).toBe("allow");
	});

	it("falls through to byRisk, then LOW/MEDIUM/HIGH defaults", () => {
		expect(mapBashClassifyAction({ classification: "LOCAL_EFFECTS", risk: "LOW" }, {})).toBe("allow");
		expect(mapBashClassifyAction({ classification: "EXTERNAL_EFFECTS", risk: "MEDIUM" }, {})).toBe("ask");
		expect(mapBashClassifyAction({ classification: "DANGEROUS", risk: "HIGH" }, { byRisk: { HIGH: "deny" } })).toBe(
			"deny",
		);
	});
});

describe("parseBashClassifyJson", () => {
	it("reads classification and risk", () => {
		expect(parseBashClassifyJson(`{"classification":"READONLY","risk":"LOW"}`)).toEqual({
			classification: "READONLY",
			risk: "LOW",
		});
	});

	it("treats a missing verdict as UNKNOWN / HIGH", () => {
		expect(parseBashClassifyJson(`{}`)).toEqual({ classification: "UNKNOWN", risk: "HIGH" });
	});
});

describe("classifyBashCommands", () => {
	it("takes the most restrictive action across targets", async () => {
		const run = async (command: string) =>
			command.includes("rm")
				? { classification: "DANGEROUS", risk: "HIGH" }
				: { classification: "READONLY", risk: "LOW" };
		const action = await classifyBashCommands(
			["ls", "rm -rf /tmp/x"],
			{ byRisk: { LOW: "allow", HIGH: "ask" } },
			"ask",
			run,
		);
		expect(action).toBe("ask");
	});

	it("uses fallback when the runner throws", async () => {
		const action = await classifyBashCommands(["mystery"], {}, "ask", async () => {
			throw new Error("missing binary");
		});
		expect(action).toBe("ask");
	});
});

describe("mergeClassifyMaps", () => {
	it("lets the mode overlay the global maps", () => {
		expect(
			mergeClassifyMaps({ byRisk: { LOW: "allow", HIGH: "ask" } }, { byRisk: { HIGH: "deny" } }).byRisk,
		).toEqual({ LOW: "allow", HIGH: "deny" });
	});
});

describe("pattern overrides beat classify", () => {
	it("denies an explicit rm rule without sending that unit to classify", () => {
		const rules = { bash: { "*": "classify" as const, "rm *": "deny" as const } };
		const denied = evaluateBashCommand("ls && rm foo", rules, wrappers, 2, cwd);
		expect(denied.action).toBe("deny");
		expect(denied.subject).toBe("ls && rm foo");
	});

	it("keeps classify for units that only match *", () => {
		const rules = { bash: { "*": "classify" as const, "rm *": "deny" as const } };
		const classified = evaluateBashCommand("git push origin", rules, wrappers, 2, cwd);
		expect(classified.action).toBe("classify");
		expect(classified.classifyTargets).toEqual(["git push origin"]);
	});
});
