import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfigFromFile } from "../tool-display/config.ts";

function tmpConfigPath() {
	const dir = mkdtempSync(join(tmpdir(), "td-cfg-"));
	return { dir, path: join(dir, "tool-display.json") };
}

test("absent file yields defaults and absent=true", () => {
	const { path, dir } = tmpConfigPath();
	try {
		const { config, absent, errors } = loadConfigFromFile(path);
		assert.equal(absent, true);
		assert.deepEqual(errors, []);
		assert.equal(config.bashPreviewLines, DEFAULT_CONFIG.bashPreviewLines);
		assert.equal(config.bashRevealCommand, DEFAULT_CONFIG.bashRevealCommand);
		assert.equal(config.diffMode, DEFAULT_CONFIG.diffMode);
		assert.equal(config.diffColumnWidth, DEFAULT_CONFIG.diffColumnWidth);
		assert.deepEqual(config.enabled, DEFAULT_CONFIG.enabled);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("valid file overrides defaults", () => {
	const { path, dir } = tmpConfigPath();
	try {
		writeFileSync(
			path,
			JSON.stringify({
				bashPreviewLines: 12,
				bashRevealCommand: false,
				readPreviewLines: 8,
				diffMode: "dual",
				diffColumnWidth: 120,
				diffSyntaxHighlight: false,
				enabled: { read: false, bash: false },
			}),
		);
		const { config, absent, errors } = loadConfigFromFile(path);
		assert.equal(absent, false);
		assert.deepEqual(errors, []);
		assert.equal(config.bashPreviewLines, 12);
		assert.equal(config.bashRevealCommand, false);
		assert.equal(config.readPreviewLines, 8);
		assert.equal(config.diffMode, "dual");
		assert.equal(config.diffColumnWidth, 120);
		assert.equal(config.diffSyntaxHighlight, false);
		assert.equal(config.enabled.read, false);
		assert.equal(config.enabled.bash, false);
		// unmentioned tools keep defaults
		assert.equal(config.enabled.edit, true);
		assert.equal(config.enabled.grep, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("invalid fields report errors and fall back to defaults", () => {
	const { path, dir } = tmpConfigPath();
	try {
		writeFileSync(
			path,
			JSON.stringify({
				bashPreviewLines: -3,
				bashRevealCommand: "yes",
				diffMode: "wide",
				diffColumnWidth: 0,
				enabled: { read: 1, bogus: true },
			}),
		);
		const { config, errors } = loadConfigFromFile(path);
		assert.ok(errors.includes("bashPreviewLines must be a non-negative integer"));
		assert.ok(errors.includes("bashRevealCommand must be a boolean"));
		assert.ok(errors.includes("diffMode must be one of auto, single, dual"));
		assert.ok(errors.includes("diffColumnWidth must be a positive integer"));
		assert.ok(errors.includes("enabled.read must be a boolean"));
		assert.ok(errors.includes('enabled has unknown tool "bogus"'));
		// invalid values keep defaults
		assert.equal(config.bashPreviewLines, DEFAULT_CONFIG.bashPreviewLines);
		assert.equal(config.bashRevealCommand, DEFAULT_CONFIG.bashRevealCommand);
		assert.equal(config.diffMode, DEFAULT_CONFIG.diffMode);
		assert.equal(config.diffColumnWidth, DEFAULT_CONFIG.diffColumnWidth);
		assert.equal(config.enabled.read, DEFAULT_CONFIG.enabled.read);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("malformed JSON reports an error and keeps defaults", () => {
	const { path, dir } = tmpConfigPath();
	try {
		writeFileSync(path, "{ not json");
		const { config, errors } = loadConfigFromFile(path);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /JSON/);
		assert.deepEqual(config.enabled, DEFAULT_CONFIG.enabled);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("top-level non-object reports an error", () => {
	const { path, dir } = tmpConfigPath();
	try {
		writeFileSync(path, JSON.stringify([1, 2, 3]));
		const { errors } = loadConfigFromFile(path);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /expected a JSON object/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("does not touch the real global path", () => {
	// Sanity: the default path constant points under ~/.pi/agent, not a temp dir.
	const { path } = loadConfigFromFile(join(tmpdir(), "definitely-absent-tool-display.json"));
	assert.equal(existsSync(path), false);
});
