import assert from "node:assert/strict";
import test from "node:test";
import {
	buildManagedSystemPrompt,
	formatEnvironment,
	formatGeneralGuidelines,
	formatInstructionFiles,
	formatToolPrompts,
	replaceAvailableToolsInPrompt,
	replacePiPromptPrefix,
	
} from "../system-prompt-core.ts";

test("builds per-tool snippets and nested guidelines inside <tool_use>", () => {
	const prompt = buildManagedSystemPrompt(
		"base",
		{
			cwd: "C:\\work\\project",
			appendSystemPrompt: "append",
			promptGuidelines: ["native guideline"],
			selectedTools: ["read", "bash"],
			toolSnippets: { bash: "native bash snippet" },
			contextFiles: [{ path: "C:/work/AGENTS.md", content: "agent rules" }],
			skills: [{ name: "demo" }],
		},
		{
			read: {
				snippet: "Read file contents.",
				guidelines: ["Read before editing.", "Read before editing."],
			},
		},
		["be concise"],
		{ cwd: "/work/project", worktree: "/work", isGitRepo: true, platform: "linux" },
		"/work/.pi/agent",
		() => "<skill>\n  <name>demo</name>\n</skill>",
	);

	assert.match(prompt, /<tool_use>\n- read: Read file contents\.\n  - Read before editing\.\n- bash: native bash snippet\n\nIn addition to the tools above, you may have access to other custom tools depending on the project\.\n<\/tool_use>/);
	assert.match(prompt, /<general_guidelines>\n- be concise\n<\/general_guidelines>/);
	assert.match(prompt, /<env>\n  Working directory: \/work\/project\n  Workspace root folder: \/work\n  Is directory a git repo: yes\n  Platform: linux\n<\/env>/);
	assert.match(prompt, /<project_instruction>\n<instruction path="C:\/work\/AGENTS\.md">\nagent rules\n<\/instruction>\n<\/project_instruction>/);
	assert.match(prompt, /<skill>\n  <name>demo<\/name>\n<\/skill>/);
	assert.doesNotMatch(prompt, /<available_skills>/);
	assert.match(prompt, /append/);
	assert.equal((prompt.match(/  - Read before editing\./g) ?? []).length, 1);
	assert.doesNotMatch(prompt, /Guidelines:\n- native guideline/);
});

test("does not format skills when read is unavailable", () => {
	const prompt = buildManagedSystemPrompt(
		"base",
		{ cwd: "/tmp/project", selectedTools: ["bash"], skills: [{ name: "demo" }] },
		{},
		[],
		{ cwd: "/tmp/project", worktree: "/tmp/project", isGitRepo: false, platform: "linux" },
		"/tmp/.pi/agent",
		() => "<available_skills>",
	);

	assert.doesNotMatch(prompt, /available_skills/);
});

test("does not emit <general_guidelines> when there are no general guidelines", () => {
	const section = formatGeneralGuidelines([]);
	assert.equal(section, "");
});

test("does not emit <tool_use> when no tools have snippets", () => {
	const section = formatToolPrompts({ cwd: "/tmp", selectedTools: [] }, {});
	assert.equal(section, "");
});

test("replaces only Pi's prefix and keeps extension suffixes", () => {
	assert.equal(
		replacePiPromptPrefix("pi base\n\nother extension", "pi base", "custom base"),
		"custom base\n\nother extension",
	);
	assert.equal(replacePiPromptPrefix("replacement extension", "pi base", "custom base"), undefined);
});

test("replaces Pi's available-tools block with a <tool_use> tag and strips default guidelines", () => {
	const prompt = [
		"You are an expert coding assistant.",
		"",
		"Available tools:",
		"- read: native read",
		"",
		"In addition to the tools above, you may have access to other custom tools depending on the project.",
		"",
		"Guidelines:",
		"- Be concise in your responses",
		"- Show file paths clearly when working with files",
		"- Use bash for file operations like ls, rg, find",
		"",
		"Pi documentation (read only when the user asks about pi itself):",
		"- Main documentation: README.md",
	].join("\n");
	const result = replaceAvailableToolsInPrompt(
		prompt,
		{ cwd: "/tmp/project", selectedTools: ["read"] },
		{ read: { snippet: "custom read", guidelines: ["Read first."] } },
		["be concise"],
		true,
	);

	assert.ok(result.includes("<tool_use>"));
	assert.ok(result.includes("- read: custom read"));
	assert.ok(result.includes("Read first."));
	assert.ok(!result.includes("Available tools:\n"));
	assert.ok(result.includes("</tool_use>"));
	assert.ok(result.includes("Pi documentation"));
	assert.ok(result.endsWith("<general_guidelines>\n- be concise\n</general_guidelines>"));
	assert.ok(!result.includes("Be concise in your responses"));
	assert.ok(!result.includes("Use bash for file operations"));
});

test("keeps Pi's default Guidelines section when stripPiDefaults is false", () => {
	const prompt = [
		"Available tools:",
		"- read: native read",
		"",
		"In addition to the tools above, you may have access to other custom tools depending on the project.",
		"",
		"Guidelines:",
		"- Be concise in your responses",
		"- Show file paths clearly when working with files",
		"",
		"Pi documentation (read only when the user asks about pi itself):",
		"- Main documentation: README.md",
	].join("\n");
	const result = replaceAvailableToolsInPrompt(
		prompt,
		{ cwd: "/tmp/project", selectedTools: ["read"] },
		{ read: { snippet: "custom read", guidelines: ["Read first."] } },
		[],
		false,
	);
	assert.ok(result.includes("- read: custom read"));
	assert.ok(result.includes("- Be concise in your responses"));
	assert.ok(result.includes("- Show file paths clearly when working with files"));
	assert.ok(!result.includes("<general_guidelines>"));
});

test("formatInstructionFiles splits context by agent dir", () => {
	const out = formatInstructionFiles(
		[
			{ path: "/home/louis/.pi/agent/AGENTS.md", content: "global content" },
			{ path: "/work/project/AGENTS.md", content: "project root" },
			{ path: "/work/project/child/CLAUDE.md", content: "project child" },
		],
		"/home/louis/.pi/agent",
	);
	assert.match(out, /^<global_instruction>\n<instruction path="\/home\/louis\/\.pi\/agent\/AGENTS\.md">\nglobal content\n<\/instruction>\n<\/global_instruction>\n\n<project_instruction>\n<instruction path="\/work\/project\/AGENTS\.md">\nproject root\n<\/instruction>\n<instruction path="\/work\/project\/child\/CLAUDE\.md">\nproject child\n<\/instruction>\n<\/project_instruction>$/);
});

test("formatInstructionFiles only emits project_instruction when no global", () => {
	const out = formatInstructionFiles(
		[{ path: "/work/project/AGENTS.md", content: "project root" }],
		"/home/louis/.pi/agent",
	);
	assert.ok(!out.includes("<global_instruction>"));
	assert.match(out, /^<project_instruction>[\s\S]+<\/project_instruction>$/);
});



test("formatEnvironment produces opencode-shaped <env> block", () => {
	const block = formatEnvironment({
		cwd: "/work/project",
		worktree: "/work",
		isGitRepo: true,
		platform: "darwin",
	});
	assert.equal(
		block,
		[
			"<env>",
			"  Working directory: /work/project",
			"  Workspace root folder: /work",
			"  Is directory a git repo: yes",
			"  Platform: darwin",
			"</env>",
		].join("\n"),
	);
});