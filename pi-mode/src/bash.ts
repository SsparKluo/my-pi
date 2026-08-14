import { parse, type Command, type Node, type ParsedScript, type Word } from "unbash";
import type { PermissionRules } from "./config.ts";
import { evaluatePermission, type PermissionVerdict } from "./permission.ts";

const HIDING_NAMES = new Set(["eval", "sudo", "xargs"]);
const SHELL_NAMES = new Set(["bash", "sh"]);
const COMPOUND_TYPES = new Set([
	"If",
	"For",
	"ArithmeticFor",
	"Select",
	"While",
	"Function",
	"Case",
	"Coproc",
]);

interface CommandUnit {
	text: string;
	hiding: boolean;
}

/** Bash cascade: unbash units → last-match-wins → deny/ask short-circuit → classify targets. */
export function evaluateBashCommand(
	command: string,
	rules: PermissionRules | undefined,
	wrappers: string[],
	wholeCommandThreshold: number,
	cwd: string,
): PermissionVerdict {
	const parsed = tryParse(command);
	if (!parsed) {
		const fallback = wholeCommand(command, rules, cwd);
		if (fallback.action === "deny") return fallback;
		return { ...fallback, action: "ask" };
	}

	const units = collectUnits(parsed, command, new Set(wrappers));
	if (units.length === 0) return wholeCommand(command, rules, cwd);

	const verdicts = units.map((unit) => evalUnit(unit, rules, cwd));
	const denied = verdicts.find((v) => v.action === "deny");
	if (denied) {
		return { ...denied, subject: command };
	}

	const asked = verdicts.find((v) => v.action === "ask");
	if (asked) {
		return { ...asked, subject: command };
	}

	const classify = verdicts.filter((v) => v.action === "classify");
	if (classify.length > wholeCommandThreshold) {
		const fallback = wholeCommand(command, rules, cwd);
		return fallback.action === "classify"
			? { ...fallback, subject: command, classifyTargets: [command] }
			: { ...fallback, subject: command };
	}
	if (classify.length > 0) {
		return {
			...classify[0],
			subject: command,
			classifyTargets: classify.map((v) => v.subject),
		};
	}
	return { action: "allow", surface: "bash", pattern: verdicts[0]?.pattern ?? null, subject: command, kind: "command" };
}

function tryParse(command: string): ParsedScript | null {
	try {
		const ast = parse(command);
		if (ast.errors && ast.errors.length > 0) return null;
		return ast;
	} catch {
		return null;
	}
}

function wholeCommand(command: string, rules: PermissionRules | undefined, cwd: string): PermissionVerdict {
	return evaluatePermission(rules, "bash", command, cwd);
}

function evalUnit(unit: CommandUnit, rules: PermissionRules | undefined, cwd: string): PermissionVerdict {
	const verdict = evaluatePermission(rules, "bash", unit.text, cwd);
	if (verdict.action === "deny") return verdict;
	if (unit.hiding) return { ...verdict, action: "ask" };
	return verdict;
}

function collectUnits(script: ParsedScript, source: string, wrappers: Set<string>): CommandUnit[] {
	const out: CommandUnit[] = [];
	walk(script, source, wrappers, out);
	return out;
}

function walk(node: Node | ParsedScript, source: string, wrappers: Set<string>, out: CommandUnit[]): void {
	switch (node.type) {
		case "Script":
		case "CompoundList":
			for (const stmt of node.commands) walk(stmt, source, wrappers, out);
			return;
		case "Statement":
			walk(node.command, source, wrappers, out);
			return;
		case "AndOr":
		case "Pipeline":
			for (const child of node.commands) walk(child, source, wrappers, out);
			return;
		case "Subshell":
		case "BraceGroup":
			walk(node.body, source, wrappers, out);
			return;
		case "Command":
			out.push(commandUnit(node, source, wrappers));
			return;
		case "TestCommand":
		case "ArithmeticCommand":
			out.push({ text: source.slice(node.pos, node.end), hiding: false });
			return;
		default:
			if (COMPOUND_TYPES.has(node.type)) {
				out.push({ text: source.slice(node.pos, node.end), hiding: true });
				return;
			}
			out.push({ text: source.slice(node.pos, node.end), hiding: true });
	}
}

function commandUnit(cmd: Command, source: string, wrappers: Set<string>): CommandUnit {
	const words = [cmd.name, ...cmd.suffix].filter((w): w is Word => !!w);
	let i = 0;
	while (i < words.length && wrappers.has(wordName(words[i]))) i++;
	if (i >= words.length) {
		return { text: source.slice(cmd.pos, cmd.end), hiding: false };
	}
	const rest = words.slice(i);
	const text = source.slice(rest[0].pos, cmd.end);
	return { text, hiding: isHiding(rest) };
}

function wordName(word: Word | undefined): string {
	if (!word) return "";
	return word.value || word.text;
}

function isHiding(words: Word[]): boolean {
	const name = wordName(words[0]);
	if (HIDING_NAMES.has(name)) return true;
	const texts = words.map((w) => wordName(w));
	if (SHELL_NAMES.has(name) && texts.includes("-c")) return true;
	if (name === "find" && texts.includes("-exec")) return true;
	return words.some(wordHasSubstitution);
}

function wordHasSubstitution(word: Word): boolean {
	return (word.parts ?? []).some((part) => part.type === "CommandExpansion" || part.type === "ProcessSubstitution");
}
