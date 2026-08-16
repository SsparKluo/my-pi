import { describe, expect, it } from "vitest";
import { modeStatus } from "../src/status.ts";

describe("modeStatus", () => {
	it("marks hands-off modes red", () => {
		for (const mode of ["auto", "full", "yolo"]) {
			expect(modeStatus(mode)).toEqual({ text: `◆ ${mode}`, color: "error" });
		}
	});

	it("marks write-restricted modes yellow", () => {
		for (const mode of ["plan", "restrict"]) {
			expect(modeStatus(mode)).toEqual({ text: `◆ ${mode}`, color: "warning" });
		}
	});

	it("keeps every other mode neutral", () => {
		expect(modeStatus("normal")).toEqual({ text: "◆ normal", color: "accent" });
		expect(modeStatus("default")).toEqual({ text: "◆ default", color: "accent" });
		expect(modeStatus("build")).toEqual({ text: "◆ build", color: "accent" });
	});
});
