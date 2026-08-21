import assert from "node:assert/strict";
import test from "node:test";
import { formatBashTimingLine, isRtkRewrite } from "../tool-display/rtk-rewrite.ts";

const timestamp = "2026-08-21 17:06:39";

test("marks an automatic RTK rewrite", () => {
	assert.equal(isRtkRewrite("git log --oneline", "export RTK_DB_PATH='/tmp/db'; rtk git log --oneline"), true);
});

test("does not mark commands that were not rewritten", () => {
	assert.equal(isRtkRewrite("git log --oneline", "git log --oneline"), false);
	assert.equal(isRtkRewrite("rtk git log --oneline", "rtk git log --oneline"), false);
	assert.equal(isRtkRewrite("printf rtk", "printf rtk"), false);
});

test("adds the marker only to the final timing line", () => {
	assert.equal(
		formatBashTimingLine("92ms", timestamp, false, true),
		`\uF017 took 92ms · ${timestamp} · rtk rewritten`,
	);
	assert.equal(
		formatBashTimingLine("92ms", timestamp, false, false),
		`\uF017 took 92ms · ${timestamp}`,
	);
	assert.equal(
		formatBashTimingLine("1.0s", timestamp, true, true),
		`\uF017 elapsed 1.0s · ${timestamp}`,
	);
});
