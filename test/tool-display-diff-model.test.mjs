import assert from "node:assert/strict";
import test from "node:test";
import { buildRows, parseEntries, wordDiff } from "../tool-display/diff-model.ts";

// pi display-diff format: `<sign><num> <content>`  (sign ∈ { , +, - })
const diff = [
	" 1 export const DEFAULTS = {",
	"-2   maxLines: 200,",
	"-3   maxBytes: 512 * 1024,",
	"+2   maxLines: 400,",
	"+3   maxBytes: 1024 * 1024,",
	' 4   encoding: "utf-8";',
	" 5 };",
].join("\n");

function joinText(segs) {
	return segs.map((s) => s.text).join("");
}

test("parseEntries reads kinds and tracks new-file line numbers via delta", () => {
	const entries = parseEntries(diff);
	assert.equal(entries.length, 7);
	assert.deepEqual(
		entries.map((e) => e.kind),
		["context", "remove", "remove", "add", "add", "context", "context"],
	);
	// context oldNum -> newNum: 2 removes + 2 adds cancel, so later context keeps its number.
	assert.equal(entries[0].oldNum, 1);
	assert.equal(entries[0].newNum, 1);
	assert.equal(entries[1].oldNum, 2);
	assert.equal(entries[5].oldNum, 4);
	assert.equal(entries[5].newNum, 4);
	assert.equal(entries[6].newNum, 5);
});

test("buildRows pairs adjacent removes+adds into mod rows and preserves context", () => {
	const rows = buildRows(parseEntries(diff));
	assert.deepEqual(
		rows.map((r) => r.type),
		["context", "mod", "mod", "context", "context"],
	);
	const firstMod = rows[1];
	assert.equal(firstMod.oldNum, 2);
	assert.equal(firstMod.newNum, 2);
	// segments reconstruct the original line content
	assert.equal(joinText(firstMod.old), "  maxLines: 200,");
	assert.equal(joinText(firstMod.neu), "  maxLines: 400,");
});

test("word-diff marks only the differing token as changed", () => {
	const rows = buildRows(parseEntries(diff));
	const firstMod = rows[1];
	const oldChanged = firstMod.old.filter((s) => !s.common).map((s) => s.text).join("");
	const oldCommon = firstMod.old.filter((s) => s.common).map((s) => s.text).join("");
	assert.ok(oldChanged.includes("200"), `expected changed token to include 200, got: ${oldChanged}`);
	assert.ok(oldCommon.includes("maxLines"), `expected common text to include maxLines, got: ${oldCommon}`);
	assert.ok(!oldChanged.includes("maxLines"));
	const newChanged = firstMod.neu.filter((s) => !s.common).map((s) => s.text).join("");
	assert.ok(newChanged.includes("400"));
});

test("pure removals become del rows; pure insertions become ins rows", () => {
	const delDiff = [" 1 a", "-2 b", "-3 c", " 4 d"].join("\n");
	const delRows = buildRows(parseEntries(delDiff));
	assert.deepEqual(
		delRows.map((r) => r.type),
		["context", "del", "del", "context"],
	);
	assert.equal(delRows[1].oldNum, 2);
	assert.equal(delRows[2].oldNum, 3);

	const insDiff = [" 1 a", "+2 b", " 3 c"].join("\n");
	const insEntries = parseEntries(insDiff);
	// add shifts delta +1, so the trailing context's newNum is oldNum+1
	assert.equal(insEntries[2].oldNum, 3);
	assert.equal(insEntries[2].newNum, 4);
	const insRows = buildRows(insEntries);
	assert.deepEqual(
		insRows.map((r) => r.type),
		["context", "ins", "context"],
	);
	assert.equal(insRows[1].newNum, 2);
});

test("wordDiff on a simple swap", () => {
	const { old, neu } = wordDiff("a b c", "a X c");
	assert.deepEqual(
		old.map((s) => ({ t: s.text, c: s.common })),
		[
			{ t: "a", c: true },
			{ t: " ", c: true },
			{ t: "b", c: false },
			{ t: " ", c: true },
			{ t: "c", c: true },
		],
	);
	assert.deepEqual(
		neu.map((s) => ({ t: s.text, c: s.common })),
		[
			{ t: "a", c: true },
			{ t: " ", c: true },
			{ t: "X", c: false },
			{ t: " ", c: true },
			{ t: "c", c: true },
		],
	);
});

test("collapseDistantContext keeps 3 context lines around each distant change block", () => {
	// Seven context lines is the first collapsible run: keep 3 + 3, skip 1.
	const lines = ["-1 old-a", "+1 new-a"];
	for (let n = 2; n <= 8; n++) {
		lines.push(` ${n} ctx-${n}`);
	}
	lines.push("-9 old-b", "+9 new-b");
	const rows = buildRows(parseEntries(lines.join("\n")));
	const gapIndex = rows.findIndex((row) => row.type === "gap");
	assert.ok(gapIndex >= 0, "expected a gap row");
	const gap = rows[gapIndex];
	assert.equal(gap.skipped, 1);
	assert.deepEqual(rows.slice(gapIndex - 3, gapIndex).map((row) => row.type), ["context", "context", "context"]);
	assert.deepEqual(rows.slice(gapIndex + 1, gapIndex + 4).map((row) => row.type), ["context", "context", "context"]);
});

test("collapseDistantContext leaves six or fewer context lines alone", () => {
	const lines = ["-1 a", "+1 b"];
	for (let n = 2; n <= 7; n++) {
		lines.push(` ${n} ctx-${n}`);
	}
	lines.push("-8 e", "+8 f");
	const rows = buildRows(parseEntries(lines.join("\n")));
	assert.equal(rows.some((row) => row.type === "gap"), false);
});

test("collapseDistantContext does not collapse leading or trailing context", () => {
	const leading = Array.from({ length: 8 }, (_, index) => ` ${index + 1} before-${index + 1}`);
	const trailing = Array.from({ length: 8 }, (_, index) => ` ${index + 10} after-${index + 1}`);
	const rows = buildRows(parseEntries([...leading, "-9 old", "+9 new", ...trailing].join("\n")));
	assert.equal(rows.some((row) => row.type === "gap"), false);
});

// ── fffind/ffgrep result counting ──
import { countFffFindResults, countFffGrepMatches } from "../tool-display/utils.ts";

test("countFffGrepMatches counts FFF ` N: line` matches and ignores notices", () => {
	const text = [
		"src/a.ts",
		" 10: const x = 1;",
		" 20: const y = 2;",
		"",
		"src/b.ts",
		" 3: export const z = 3;",
		"",
		'[Continue with cursor="fff_c1"]',
	].join("\n");
	// notice is single-bracket at end without blank line before in this fixture —
	// splitTrailingNoticeBlock needs \n\n[...]. Use the double-newline form:
	const withNotice = `${text.split("\n").slice(0, -1).join("\n")}\n\n[Continue with cursor="fff_c1"]`;
	assert.equal(countFffGrepMatches(withNotice), 3);
	assert.equal(countFffGrepMatches("No matches found"), 0);
});

test("countFffFindResults counts path lines and ignores notices", () => {
	const text = ["src/a.ts", "src/b.ts", "lib/c.ts"].join("\n");
	assert.equal(countFffFindResults(text), 3);
	assert.equal(countFffFindResults(`${text}\n\n[12 more matches available. cursor="1" to continue]`), 3);
	assert.equal(countFffFindResults("No files found matching pattern"), 0);
});
