import assert from "node:assert/strict";
import test from "node:test";
import {
	GROUP_ARROW,
	GROUP_HANG,
	formatGroupFooter,
	joinCompactLine,
	layoutGroup,
	stripHangPad,
	stripLeadingCallChrome,
} from "../tool-display/group.ts";

const ok = (name) => ({ name, isError: false });
const bad = (name) => ({ name, isError: true });

test("footer is omitted for a single tool", () => {
	assert.equal(formatGroupFooter([ok("read")]), undefined);
	assert.equal(formatGroupFooter([]), undefined);
});

test("footer counts types in appearance order and marks failures", () => {
	assert.equal(
		formatGroupFooter([ok("read"), ok("read"), ok("bash")]),
		"3 tools called: 2 read, 1 bash",
	);
	assert.equal(
		formatGroupFooter([bad("bash"), ok("read"), ok("read")]),
		"3 tools called: 1 bash ✗, 2 read",
	);
	assert.equal(
		formatGroupFooter([ok("edit"), bad("edit"), ok("edit"), ok("grep")]),
		"4 tools called: 3 edit (2✓ 1✗), 1 grep",
	);
});

test("stripLeadingCallChrome drops pad and the status dot, keeping ANSI in the body", () => {
	assert.equal(stripLeadingCallChrome(" ● read foo.ts"), "read foo.ts");
	assert.equal(stripLeadingCallChrome("● read foo.ts"), "read foo.ts");
	const colored = ` \x1b[32m●\x1b[0m \x1b[1mread\x1b[0m foo.ts`;
	assert.equal(stripLeadingCallChrome(colored), "\x1b[1mread\x1b[0m foo.ts");
});

test("stripHangPad drops hang indent and leaves the summary", () => {
	assert.equal(stripHangPad("   24 lines", 3), "24 lines");
	assert.equal(stripHangPad("  24 lines", 2), "24 lines");
	assert.equal(stripHangPad("\x1b[2m   24 lines", 3), "24 lines");
});

test("joinCompactLine inserts the separator only when both sides exist", () => {
	assert.equal(joinCompactLine("read foo.ts", "24 lines", "·"), "read foo.ts · 24 lines");
	assert.equal(joinCompactLine("read foo.ts", "", "·"), "read foo.ts");
	assert.equal(joinCompactLine("read foo.ts", undefined, "·"), "read foo.ts");
	assert.equal(joinCompactLine("", "24 lines", "·"), "24 lines");
});

test("layoutGroup draws one dot per member and a hanging footer", () => {
	const { lines, members, footerY } = layoutGroup({
		paddingX: 1,
		members: [
			{ dot: "\x1b[36m●\x1b[0m", wrapped: ["read foo.ts · 24 lines"] },
			{ dot: "\x1b[36m●\x1b[0m", wrapped: ["read bar.ts · 12 lines"] },
			{ dot: "\x1b[31m●\x1b[0m", wrapped: ["bash $ ls · 3 lines"] },
		],
		footer: "3 tools called: 2 read, 1 bash",
	});
	const hang = " ".repeat(GROUP_HANG);
	assert.deepEqual(lines, [
		` \x1b[36m●\x1b[0m read foo.ts · 24 lines`,
		` \x1b[36m●\x1b[0m read bar.ts · 12 lines`,
		` \x1b[31m●\x1b[0m bash $ ls · 3 lines`,
		` ${GROUP_ARROW} 3 tools called: 2 read, 1 bash`,
	]);
	assert.deepEqual(members, [
		{ y: 0, height: 1 },
		{ y: 1, height: 1 },
		{ y: 2, height: 1 },
	]);
	assert.equal(footerY, 3);
});

test("layoutGroup aligns wrapped member lines under the body column", () => {
	const { lines, members } = layoutGroup({
		paddingX: 1,
		members: [
			{ dot: "●", wrapped: ["read very/long/path.ts ·", "24 lines"] },
			{ dot: "●", wrapped: ["bash $ git add lots of files · 15", "lines"] },
		],
		footer: "2 tools called: 1 read, 1 bash",
	});
	assert.deepEqual(lines, [
		" ● read very/long/path.ts ·",
		"   24 lines",
		" ● bash $ git add lots of files · 15",
		"   lines",
		` ${GROUP_ARROW} 2 tools called: 1 read, 1 bash`,
	]);
	assert.deepEqual(members, [
		{ y: 0, height: 2 },
		{ y: 2, height: 2 },
	]);
});
