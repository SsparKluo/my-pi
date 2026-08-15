/**
 * Port of bash-classify classifier.py on top of unbash.
 * Extracts invocations (argv, redirects, pipeline position, background,
 * context) from the AST, matches each against the command database, applies
 * elevations (redirects, backgrounding, system paths, /dev/tcp), and composes
 * the overall classification/risk by max severity.
 */
import { parse } from "unbash";
import { matchCommand, registerInnerExpressionParser } from "./matcher.ts";
import type { CommandGrade, ExpressionGrade, Invocation, Redirect } from "./types.ts";
import { COMMAND_DB } from "./loader.ts";
import { maxSeverityClass, maxSeverityRisk } from "./types.ts";

const WRITE_OPERATORS = new Set([">", ">>", "2>", "&>", ">&"]);
const READ_OPERATORS = new Set(["<"]);

/** tree-sitter parses these as declarations, not commands (no invocation). */
const DECLARATION_BUILTINS = new Set(["export", "declare", "local", "readonly", "typeset"]);
const DEV_PATHS = ["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/fd/"];

const SYSTEM_DIRS = [
	"/etc",
	"/lib",
	"/lib64",
	"/usr",
	"/bin",
	"/sbin",
	"/boot",
	"/sys",
	"/proc",
	"/run",
	"/srv",
	"/root",
	"/opt",
	"/var",
	"/dev",
];
const SAFE_PREFIXES = [
	"/tmp",
	"/var/tmp",
	"/home",
	"/dev/null",
	"/dev/stdin",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/fd",
	"/dev/tcp",
	"/dev/udp",
];

interface UnbashWord {
	type?: string;
	text?: string;
	value?: string;
	parts?: UnbashWord[];
	script?: UnbashNode;
}

interface UnbashNode {
	type: string;
	pos: number;
	end: number;
	commands?: UnbashNode[];
	command?: UnbashNode;
	background?: boolean;
	name?: UnbashWord;
	prefix?: unknown[];
	suffix?: UnbashWord[];
	redirects?: UnbashRedirect[];
	body?: UnbashNode;
	script?: UnbashNode;
}

interface UnbashRedirect {
	operator: string;
	target?: UnbashWord;
}

function isTempPath(path: string): boolean {
	return path.startsWith("/tmp/") || path === "/tmp" || path.startsWith("/var/tmp/") || path === "/var/tmp";
}

function isRealFilePath(path: string): boolean {
	return !DEV_PATHS.some((dev) => path === dev || path.startsWith(dev));
}

function isSystemPath(path: string): boolean {
	if (!path.startsWith("/")) return false;
	for (const safe of SAFE_PREFIXES) {
		if (path === safe || path.startsWith(`${safe}/`)) return false;
	}
	return SYSTEM_DIRS.some((sysdir) => path === sysdir || path.startsWith(`${sysdir}/`));
}

function redirectAffectsClassification(operator: string, target: string): boolean {
	if (target === "/dev/null") return false;
	if (operator.includes(">&") && /^\d+$/.test(target)) return false;
	if ([">", ">>", "&>", "&>>"].includes(operator)) return true;
	if (operator.endsWith(">")) return true;
	return operator.length >= 2 && /^\d/.test(operator) && operator.includes(">");
}

function toRedirect(r: UnbashRedirect): Redirect {
	const target = r.target?.value ?? "";
	return {
		operator: r.operator,
		target,
		affectsClassification: redirectAffectsClassification(r.operator, target),
	};
}

/** Flatten an unbash word into argv text (quoted flags resolve via .value). */
function wordArgv(word: UnbashWord | undefined, argv: string[], context: Invocation["context"], invocations: Invocation[]): void {
	if (!word) return;
	// Walk nested parts for command/process substitutions so their inner
	// invocations get graded too; argv text comes from the word's resolved
	// value (unbash already unquotes).
	for (const part of word.parts ?? []) collectExpansions(part, context, invocations);
	argv.push(word.value ?? word.text ?? "");
}

function collectExpansions(node: UnbashNode | UnbashWord, context: Invocation["context"], out: Invocation[]): void {
	const script = (node as UnbashWord).script ?? (node as UnbashNode).script;
	if (script) {
		collectInvocations(script, "command_substitution", out);
	}
	for (const part of (node as UnbashWord).parts ?? []) {
		collectExpansions(part, context, out);
	}
}

function collectInvocations(
	node: UnbashNode,
	context: Invocation["context"],
	out: Invocation[] = [],
	operatorBefore: string | null = null,
): Invocation[] {
	switch (node.type) {
		case "Script":
		case "CompoundList":
			for (const stmt of node.commands ?? []) collectInvocations(stmt, context, out);
			return out;
		case "Statement": {
			const before = out.length;
			collectInvocations(node.command as UnbashNode, context, out);
			if (node.background) {
				for (let i = before; i < out.length; i++) out[i].isBackground = true;
			}
			return out;
		}
		case "AndOr":
		case "Pipeline": {
			const children = node.commands ?? [];
			children.forEach((child, i) => {
				const op = node.type === "AndOr" && i > 0 ? "&&" : node.type === "Pipeline" && i > 0 ? "|" : null;
				collectInvocations(child, context, out, op);
			});
			return out;
		}
		case "Subshell":
		case "BraceGroup":
			collectInvocations(node.body as UnbashNode, "subshell", out);
			return out;
		case "Command": {
			const argv: string[] = [];
			if (node.name) wordArgv(node.name, argv, context, out);
			for (const w of node.suffix ?? []) wordArgv(w, argv, context, out);
			// Pure assignment statements (no command name) and declaration
			// builtins (export/declare/local/…) produce no invocation;
			// expansions in their args were already collected by wordArgv.
			if (argv.length === 0 || DECLARATION_BUILTINS.has(argv[0])) {
				return out;
			}
			out.push({
				argv,
				redirects: (node.redirects ?? []).map(toRedirect),
				positionInPipeline: 0,
				pipelineLength: 1,
				context,
				operatorBefore,
				isBackground: false,
			});
			return out;
		}
		default:
			// Compound forms (If/For/While/Function/TestCommand/…) — recurse into
			// any nested scripts so their invocations are still graded.
			for (const value of Object.values(node)) {
				if (value && typeof value === "object" && !Array.isArray(value) && "type" in value) {
					collectInvocations(value as UnbashNode, context, out);
				} else if (Array.isArray(value)) {
					for (const item of value) {
						if (item && typeof item === "object" && "type" in item) {
							collectInvocations(item as UnbashNode, context, out);
						}
					}
				}
			}
			return out;
	}
}

export function gradeExpression(expression: string): ExpressionGrade {
	let invocations: Invocation[];
	try {
		const ast = parse(expression);
		if (ast.errors && ast.errors.length > 0) {
			// Parse warnings with no commands -> UNKNOWN (fail-closed), as upstream.
			return emptyExpression(expression, "UNKNOWN");
		}
		invocations = collectInvocations(ast as unknown as UnbashNode, "toplevel");
	} catch {
		return emptyExpression(expression, "UNKNOWN");
	}

	// No invocations and no warnings (e.g. pure declaration) -> READONLY.
	if (invocations.length === 0) return emptyExpression(expression, "READONLY");

	const commandResults: CommandGrade[] = [];
	for (const invocation of invocations) {
		let result: CommandGrade;
		if (invocation.argv.length > 0 && invocation.argv[0].startsWith("$")) {
			result = {
				command: [invocation.argv[0]],
				argv: [...invocation.argv],
				classification: "DANGEROUS",
				risk: "HIGH",
				matchedRule: null,
				innerCommands: [],
				ignoredOptions: null,
				remainingOptions: null,
				classificationReason: "variable expansion in command position",
				overridingOption: null,
				directories: null,
				writePaths: null,
				readPaths: null,
			};
		} else {
			result = matchCommand(invocation);
		}

		// Redirect elevations.
		const writePaths: string[] = [];
		const readPaths: string[] = [];
		let allWriteTargetsAreTemp = true;
		for (const redirect of invocation.redirects) {
			if (WRITE_OPERATORS.has(redirect.operator) && isRealFilePath(redirect.target)) {
				writePaths.push(redirect.target);
				if (!isTempPath(redirect.target)) allWriteTargetsAreTemp = false;
			} else if (READ_OPERATORS.has(redirect.operator) && isRealFilePath(redirect.target)) {
				readPaths.push(redirect.target);
			}
		}
		for (const redirect of invocation.redirects) {
			if (redirect.affectsClassification) {
				const elevated = maxSeverityClass(result.classification, "LOCAL_EFFECTS");
				if (elevated !== result.classification) {
					result.classification = elevated;
					result.classificationReason = `${result.classificationReason ?? ""}; elevated by output redirect`.replace(
						/^; /,
						"",
					);
				}
				if (!(writePaths.length > 0 && allWriteTargetsAreTemp)) {
					result.risk = maxSeverityRisk(result.risk, "MEDIUM");
				}
			}
			if (redirect.target.startsWith("/dev/tcp/") || redirect.target.startsWith("/dev/udp/")) {
				result.classification = maxSeverityClass(result.classification, "DANGEROUS");
				result.classificationReason = "elevated to DANGEROUS: /dev/tcp or /dev/udp access detected";
				result.risk = "HIGH";
			}
		}
		for (const arg of invocation.argv) {
			if (arg.startsWith("/dev/tcp/") || arg.startsWith("/dev/udp/")) {
				result.classification = maxSeverityClass(result.classification, "DANGEROUS");
				result.classificationReason = "elevated to DANGEROUS: /dev/tcp or /dev/udp access detected";
				result.risk = "HIGH";
			}
		}

		// Backgrounding.
		if (invocation.isBackground) {
			const elevated = maxSeverityClass(result.classification, "LOCAL_EFFECTS");
			if (elevated !== result.classification) {
				result.classification = elevated;
				result.classificationReason = `${result.classificationReason ?? ""}; elevated by backgrounding`.replace(/^; /, "");
			}
			result.risk = maxSeverityRisk(result.risk, "MEDIUM");
		}

		// Writes into system directories.
		if (CLASS_SEV[result.classification] >= CLASS_SEV.LOCAL_EFFECTS) {
			const systemPathsFound: string[] = [];
			for (const token of invocation.argv) {
				if (isSystemPath(token)) systemPathsFound.push(token);
			}
			for (const redirect of invocation.redirects) {
				if (isSystemPath(redirect.target)) systemPathsFound.push(redirect.target);
			}
			if (systemPathsFound.length > 0 && result.classification !== "DANGEROUS") {
				result.classification = "DANGEROUS";
				result.classificationReason = `${result.classificationReason ?? ""}; elevated to DANGEROUS: system path ${systemPathsFound[0]}`.replace(/^; /, "");
				result.risk = "HIGH";
			}
		}

		result.writePaths = writePaths.length > 0 ? writePaths : null;
		result.readPaths = readPaths.length > 0 ? readPaths : null;
		commandResults.push(result);
	}

	let overall = commandResults[0].classification;
	let overallRisk = commandResults[0].risk;
	for (const r of commandResults.slice(1)) {
		overall = maxSeverityClass(overall, r.classification);
		overallRisk = maxSeverityRisk(overallRisk, r.risk);
	}

	return { expression, classification: overall, risk: overallRisk, commands: commandResults };
}

const CLASS_SEV = { READONLY: 0, LOCAL_EFFECTS: 1, EXTERNAL_EFFECTS: 2, UNKNOWN: 3, DANGEROUS: 4 } as const;

function emptyExpression(expression: string, classification: "READONLY" | "UNKNOWN"): ExpressionGrade {
	return {
		expression,
		classification,
		risk: classification === "UNKNOWN" ? "HIGH" : "LOW",
		commands: [],
	};
}

// Recursion hook for delegation mode flag_value_is_expression (bash -c "…").
registerInnerExpressionParser((expression) => {
	try {
		const ast = parse(expression);
		if (ast.errors && ast.errors.length > 0) return [];
		return collectInvocations(ast as unknown as UnbashNode, "toplevel").map((inv) => inv.argv);
	} catch {
		return [];
	}
});

export { COMMAND_DB };
