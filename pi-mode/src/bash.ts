import { parse, type Command, type Node, type ParsedScript, type Word } from "unbash";
import type { PermissionRules } from "./config.ts";
import { evaluatePermission, type PermissionVerdict } from "./permission.ts";

const ELEVATOR_NAMES = new Set(["sudo", "doas"]);

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
		if (fallback.action === "classify") {
			// Route through grading: the grader also fails to parse → UNKNOWN,
			// which the classify maps decide (model in auto, ask in normal).
			return { ...fallback, subject: command, classifyTargets: [command] };
		}
		if (fallback.action === "deny") return fallback;
		return { ...fallback, action: "ask", askUnits: [command] };
	}

	const units = collectUnits(parsed, command, new Set(wrappers));
	if (units.length === 0) return wholeCommand(command, rules, cwd);

	const verdicts = units.map((unit) => evaluatePermission(rules, "bash", unit, cwd));
	const denied = verdicts.find((v) => v.action === "deny");
	if (denied) {
		return { ...denied, subject: command };
	}

	const asked = verdicts.filter((v) => v.action === "ask");
	if (asked.length > 0) {
		return {
			...asked[0],
			subject: command,
			askUnits: asked.map((v) => v.subject),
		};
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

function collectUnits(script: ParsedScript, source: string, wrappers: Set<string>): string[] {
	const out: string[] = [];
	walk(script, source, wrappers, out);
	return out;
}

function walk(node: Node | ParsedScript, source: string, wrappers: Set<string>, out: string[]): void {
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
		default:
			// TestCommand, ArithmeticCommand, and compound forms (If/For/While/…)
			// grade as one unit; the grader recurses into their inner scripts.
			out.push(source.slice(node.pos, node.end));
	}
}

function commandUnit(cmd: Command, source: string, wrappers: Set<string>): string {
	const words = [cmd.name, ...cmd.suffix].filter((w): w is Word => !!w);
	let i = 0;
	while (i < words.length && wrappers.has(wordName(words[i]))) i++;
	// Strip a leading sudo/doas (unless its own flag follows) so pattern rules
	// match the real command: `sudo rm …` hits "rm *". The grader and the LLM
	// classifier still see the full command via the whole-command context.
	if (i + 1 < words.length && ELEVATOR_NAMES.has(wordName(words[i])) && !wordName(words[i + 1]).startsWith("-")) {
		i++;
	}
	if (i >= words.length) {
		return source.slice(cmd.pos, cmd.end);
	}
	return source.slice(words[i].pos, cmd.end);
}

function wordName(word: Word | undefined): string {
	if (!word) return "";
	return word.value || word.text;
}
