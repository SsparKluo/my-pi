import assert from "node:assert/strict";
import test from "node:test";
import {
	formatEnvironment,
	formatGeneralGuidelines,
	formatToolGuidelines,
	uniqueGuidelines,
} from "../system-prompt-core.ts";

test("formatToolGuidelines: one line per guideline with tool prefix, in loadout order", () => {
	const out = formatToolGuidelines(["read", "bash"], {
		read: { guidelines: ["Use read over cat."] },
		bash: { guidelines: ["Check PI_* env vars.", "Prefer specialized tools."] },
	});
	assert.equal(
		out,
		[
			"- read: Use read over cat.",
			"- bash: Check PI_* env vars.",
			"- bash: Prefer specialized tools.",
		].join("\n"),
	);
});

test("formatToolGuidelines: skips tools without guidelines and tools outside the loadout", () => {
	const out = formatToolGuidelines(["read"], {
		read: { snippet: "s", guidelines: ["", "  "] },
		bash: { guidelines: ["never appears"] },
	});
	assert.equal(out, "");
});

test("formatToolGuidelines: dedupes repeated guidelines within a tool", () => {
	const out = formatToolGuidelines(["read"], {
		read: { guidelines: ["same", "same", "other"] },
	});
	assert.equal(out, "- read: same\n- read: other");
});

test("formatGeneralGuidelines: bullets, dedupe, blanks dropped; empty input yields empty string", () => {
	assert.equal(
		formatGeneralGuidelines(["be concise", "be concise", "  ", "show paths"]),
		"- be concise\n- show paths",
	);
	assert.equal(formatGeneralGuidelines([]), "");
});

test("uniqueGuidelines trims and preserves first-seen order", () => {
	assert.deepEqual(uniqueGuidelines([" b ", "a", "b", ""]), ["b", "a"]);
});

test("formatEnvironment: three lines without cwd, backslashes normalized", () => {
	assert.equal(
		formatEnvironment({ worktree: "C:\\work", isGitRepo: true, platform: "darwin" }),
		[
			"Workspace root folder: C:/work",
			"Is directory a git repo: yes",
			"Platform: darwin",
		].join("\n"),
	);
	assert.equal(
		formatEnvironment({ worktree: "/tmp/x", isGitRepo: false, platform: "linux" }).split("\n")[1],
		"Is directory a git repo: no",
	);
});
