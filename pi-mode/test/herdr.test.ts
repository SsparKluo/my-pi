import { describe, expect, it } from "vitest";
import { displayAgentLabel } from "../src/herdr.ts";

describe("displayAgentLabel", () => {
	it("hides only a missing mode", () => {
		expect(displayAgentLabel(undefined)).toBeNull();
	});

	it("renders pi · <mode> for any mode", () => {
		expect(displayAgentLabel("normal")).toBe("pi · normal");
		expect(displayAgentLabel("plan")).toBe("pi · plan");
		expect(displayAgentLabel("build")).toBe("pi · build");
		expect(displayAgentLabel("yolo")).toBe("pi · yolo");
	});
});
