import { describe, expect, it } from "vitest";
import { findPersistedMode } from "../src/restore.ts";

const state = (mode: unknown, id: string) => ({
	type: "custom",
	customType: "pi-mode-state",
	data: { mode, ts: 0 },
	id,
	parentId: null,
	timestamp: "2026-08-14T00:00:00.000Z",
});

const message = (id: string) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-08-14T00:00:00.000Z",
	message: { role: "user", content: [], timestamp: 0 },
});

describe("findPersistedMode", () => {
	it("returns undefined for an empty branch", () => {
		expect(findPersistedMode([])).toBeUndefined();
	});

	it("returns undefined when no state entry exists", () => {
		expect(findPersistedMode([message("m1"), message("m2")])).toBeUndefined();
	});

	it("returns the most recent state entry on the branch", () => {
		const branch = [state("plan", "s1"), message("m1"), state("build", "s2"), message("m2")];
		expect(findPersistedMode(branch)).toBe("build");
	});

	it("keeps the older state when newer entries carry no state", () => {
		const branch = [state("plan", "s1"), message("m1"), message("m2")];
		expect(findPersistedMode(branch)).toBe("plan");
	});

	it("ignores state entries from an abandoned branch (rewind scenario)", () => {
		// File order: s1, m1, m2, s2(abandoned-branch tail), m3(new branch off m1).
		// The active branch is s1, m1, m3 — restore plan, not build.
		const branch = [state("plan", "s1"), message("m1"), message("m3")];
		expect(findPersistedMode(branch)).toBe("plan");
	});

	it("treats a malformed latest state as authoritative (no fallback to older)", () => {
		const branch = [state("plan", "s1"), message("m1"), state(42, "s2")];
		expect(findPersistedMode(branch)).toBeUndefined();
	});

	it("returns undefined for missing data", () => {
		const branch = [{ type: "custom", customType: "pi-mode-state", id: "s1", parentId: null, timestamp: "" }];
		expect(findPersistedMode(branch)).toBeUndefined();
	});

	it("ignores other custom entry types", () => {
		const branch = [
			{ type: "custom", customType: "worked-for", data: { mode: "yolo" }, id: "w1", parentId: null, timestamp: "" },
			message("m1"),
		];
		expect(findPersistedMode(branch)).toBeUndefined();
	});
});
