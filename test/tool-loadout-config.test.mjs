import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GLUE_TOOL_NAME,
	hiddenDeclarations,
	loadToolLoadoutConfig,
} from "../tool-loadout-config.ts";

function withAgentDir(json, fn) {
	const dir = mkdtempSync(join(tmpdir(), "tool-loadout-"));
	try {
		if (json !== undefined) {
			writeFileSync(join(dir, "tool-loadout.json"), typeof json === "string" ? json : JSON.stringify(json));
		}
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("missing file → hide nothing", () => {
	withAgentDir(undefined, (dir) => {
		assert.deepEqual(loadToolLoadoutConfig(dir), { hide: [] });
	});
});

test("hide list is trimmed and uniqued", () => {
	withAgentDir({ hide: [" ctx_note ", "ctx_note", "  ", "ctx_expand"] }, (dir) => {
		assert.deepEqual(loadToolLoadoutConfig(dir).hide, ["ctx_note", "ctx_expand"]);
	});
});

test("invalid hide is ignored with an error", () => {
	withAgentDir({ hide: [1] }, (dir) => {
		const loaded = loadToolLoadoutConfig(dir);
		assert.deepEqual(loaded.hide, []);
		assert.equal(typeof loaded.error, "string");
	});
});

test("hiddenDeclarations keeps only declared names and always includes the glue tool", () => {
	assert.deepEqual(
		hiddenDeclarations(["ctx_note", "missing"], ["read", "ctx_note", GLUE_TOOL_NAME]),
		["ctx_note", GLUE_TOOL_NAME],
	);
	assert.deepEqual(hiddenDeclarations([], ["read", GLUE_TOOL_NAME]), [GLUE_TOOL_NAME]);
});
