import { describe, expect, it } from "vitest";
import { displayAgentLabel } from "../src/herdr.ts";

describe("displayAgentLabel", () => {
	it("hides the default / missing mode", () => {
		expect(displayAgentLabel(undefined)).toBeNull();
		expect(displayAgentLabel("default")).toBeNull();
	});

	it("renders pi · <mode> for any other mode", () => {
		expect(displayAgentLabel("plan")).toBe("pi · plan");
		expect(displayAgentLabel("build")).toBe("pi · build");
		expect(displayAgentLabel("yolo")).toBe("pi · yolo");
	});
});
