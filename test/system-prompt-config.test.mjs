import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../system-prompt-config.ts";

const CONFIG_DIR_NAME = ".pi";
const CONFIG_FILE_NAME = "system-prompt.json";

function setupEnv() {
	const agentDir = mkdtempSync(join(tmpdir(), "sp-cfg-agent-"));
	const project = mkdtempSync(join(tmpdir(), "sp-cfg-proj-"));
	mkdirSync(join(project, CONFIG_DIR_NAME), { recursive: true });
	return {
		agentDir,
		project,
		cleanup: () => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		},
	};
}

function writeGlobal(env, obj) {
	writeFileSync(join(env.agentDir, CONFIG_FILE_NAME), JSON.stringify(obj));
}

function writeProject(env, obj) {
	writeFileSync(join(env.project, CONFIG_DIR_NAME, CONFIG_FILE_NAME), JSON.stringify(obj));
}

function load(env, { trusted = true } = {}) {
	return loadConfig({
		cwd: env.project,
		trusted,
		agentDir: env.agentDir,
		configDirName: CONFIG_DIR_NAME,
	});
}

test("absent: both files missing → absent=true, empty config", () => {
	const env = setupEnv();
	try {
		const cfg = load(env);
		assert.equal(cfg.absent, true);
		assert.equal(cfg.basePrompt, undefined);
		assert.deepEqual(cfg.general, []);
		assert.deepEqual(cfg.tools, {});
		assert.deepEqual(cfg.errors, []);
	} finally {
		env.cleanup();
	}
});

test("absent: untrusted project treated as absent even when project file exists", () => {
	const env = setupEnv();
	try {
		writeProject(env, { basePrompt: "project only" });
		// only project exists, global missing, AND untrusted → project ignored → absent
		const cfg = load(env, { trusted: false });
		assert.equal(cfg.absent, true);
		assert.equal(cfg.basePrompt, undefined);
	} finally {
		env.cleanup();
	}
});

test("project basePrompt wins over global", () => {
	const env = setupEnv();
	try {
		writeGlobal(env, { basePrompt: "global base" });
		writeProject(env, { basePrompt: "project base" });
		const cfg = load(env);
		assert.equal(cfg.absent, false);
		assert.equal(cfg.basePrompt, "project base");
	} finally {
		env.cleanup();
	}
});

test("global basePrompt used when project omits it", () => {
	const env = setupEnv();
	try {
		writeGlobal(env, { basePrompt: "global base" });
		writeProject(env, { tools: { read: { snippet: "r", guidelines: [] } } });
		const cfg = load(env);
		assert.equal(cfg.basePrompt, "global base");
	} finally {
		env.cleanup();
	}
});

test("general merges global-first then project, dedup not applied (order preserved)", () => {
	const env = setupEnv();
	try {
		writeGlobal(env, { general: ["g1", "g2"] });
		writeProject(env, { general: ["p1", "g1"] });
		const cfg = load(env);
		assert.deepEqual(cfg.general, ["g1", "g2", "p1", "g1"]);
	} finally {
		env.cleanup();
	}
});

test("tools merge by name; project entry overrides global entry", () => {
	const env = setupEnv();
	try {
		writeGlobal(env, {
			tools: {
				read: { snippet: "g-read", guidelines: ["gr"] },
				bash: { snippet: "g-bash", guidelines: ["gb"] },
			},
		});
		writeProject(env, {
			tools: {
				read: { snippet: "p-read", guidelines: ["pr"] },
				edit: { snippet: "p-edit", guidelines: ["pe"] },
			},
		});
		const cfg = load(env);
		assert.equal(cfg.tools.read.snippet, "p-read");
		assert.deepEqual(cfg.tools.read.guidelines, ["pr"]);
		assert.equal(cfg.tools.bash.snippet, "g-bash");
		assert.equal(cfg.tools.edit.snippet, "p-edit");
	} finally {
		env.cleanup();
	}
});

test("basePrompt trimming: whitespace-only basePrompt becomes undefined", () => {
	const env = setupEnv();
	try {
		writeGlobal(env, { basePrompt: "   " });
		const cfg = load(env);
		assert.equal(cfg.basePrompt, undefined);
	} finally {
		env.cleanup();
	}
});

test("guidelines and snippets are trimmed; empty entries filtered", () => {
	const env = setupEnv();
	try {
		writeGlobal(env, {
			tools: {
				read: {
					snippet: "  Read file contents  ",
					guidelines: ["  keep this  ", "   ", ""],
				},
			},
		});
		const cfg = load(env);
		assert.equal(cfg.tools.read.snippet, "Read file contents");
		assert.deepEqual(cfg.tools.read.guidelines, ["keep this"]);
	} finally {
		env.cleanup();
	}
});

test("invalid JSON surfaces an error and does not crash", () => {
	const env = setupEnv();
	try {
		writeGlobal(env, "{ not valid json");
		const cfg = load(env);
		assert.equal(cfg.absent, false);
		assert.equal(cfg.errors.length, 1);
		assert.match(cfg.errors[0], /expected|JSON|Unexpected/i);
	} finally {
		env.cleanup();
	}
});

test("schema violation: tools.<name>.snippet must be non-empty string", () => {
	const env = setupEnv();
	try {
		writeProject(env, { tools: { read: { snippet: "", guidelines: [] } } });
		const cfg = load(env);
		assert.equal(cfg.errors.length, 1);
		assert.match(cfg.errors[0], /tools\.read\.snippet must be a non-empty string/);
	} finally {
		env.cleanup();
	}
});

test("schema violation: basePrompt must be a string", () => {
	const env = setupEnv();
	try {
		writeProject(env, { basePrompt: 42 });
		const cfg = load(env);
		assert.equal(cfg.errors.length, 1);
		assert.match(cfg.errors[0], /basePrompt must be a string/);
	} finally {
		env.cleanup();
	}
});

test("schema violation: tools must be an object", () => {
	const env = setupEnv();
	try {
		writeProject(env, { tools: [] });
		const cfg = load(env);
		assert.equal(cfg.errors.length, 1);
		assert.match(cfg.errors[0], /tools must be an object/);
	} finally {
		env.cleanup();
	}
});

test("global error + valid project both surface; project config still loads", () => {
	const env = setupEnv();
	try {
		writeGlobal(env, "{ broken");
		writeProject(env, { basePrompt: "project base" });
		const cfg = load(env);
		assert.equal(cfg.basePrompt, "project base");
		assert.equal(cfg.errors.length, 1);
		assert.match(cfg.errors[0], /broken|JSON/i);
	} finally {
		env.cleanup();
	}
});
