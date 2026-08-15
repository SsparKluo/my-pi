/**
 * Port of bash-classify matcher.py — match a parsed invocation against the
 * command database: binary lookup, global-option stripping, subcommand walk,
 * option classification (overrides / risk / delegation), strict mode.
 */
import type {
	Classification,
	CommandDef,
	CommandGrade,
	InnerCommandGrade,
	Invocation,
	OptionDef,
	Risk,
} from "./types.ts";
import { COMMAND_DB } from "./loader.ts";
import { clampRisk, defaultRisk, maxSeverityClass, maxSeverityRisk } from "./types.ts";

const BUILTIN_DIRECTORY_COMMANDS = new Set(["cd", "pushd", "popd"]);
const BUILTIN_READONLY_COMMANDS = new Set(["[", "[[", "test"]);
const BUILTIN_DANGEROUS_COMMANDS = new Set(["eval", "source", ".", "exec"]);

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function matchCommand(invocation: Invocation, database: Record<string, CommandDef> = COMMAND_DB): CommandGrade {
	const argv = invocation.argv;
	if (argv.length === 0) {
		return emptyGrade(argv, "UNKNOWN", "HIGH");
	}

	let binary = argv[0];

	if (BUILTIN_DIRECTORY_COMMANDS.has(binary)) {
		return builtinGrade(argv, "READONLY", "LOW");
	}
	if (BUILTIN_READONLY_COMMANDS.has(binary)) {
		return builtinGrade(argv, "READONLY", "LOW");
	}
	if (BUILTIN_DANGEROUS_COMMANDS.has(binary)) {
		return builtinGrade(argv, "DANGEROUS", "HIGH");
	}

	let commandDef = database[binary];
	if (commandDef === undefined && binary.includes("/")) {
		const basename = binary.split("/").pop() ?? binary;
		commandDef = database[basename];
		if (commandDef !== undefined) binary = basename;
	}
	if (commandDef === undefined) {
		return {
			...emptyGrade(argv, "UNKNOWN", "HIGH"),
			classificationReason: "command not in database",
		};
	}

	if (commandDef.aliasOf !== null) {
		const target = database[commandDef.aliasOf];
		if (!target) throw new Error(`${binary} aliases '${commandDef.aliasOf}' which is not in the database`);
		if (target.aliasOf !== null) throw new Error(`alias chain too deep: ${binary} -> ${commandDef.aliasOf}`);
		commandDef = target;
	}

	let remaining = argv.slice(1);

	const stripped = stripGlobalOptions(remaining, commandDef);
	remaining = stripped.remaining;
	const globalOverrides = stripped.overrides;
	const globalRiskOverrides = stripped.riskOverrides;

	let matchedDef: CommandDef;
	let commandChain: string[];
	let matchedDefs: CommandDef[] = [];
	if (commandDef.subcommandMode === "match_all") {
		const m = matchAllSubcommands(remaining, commandDef);
		commandChain = m.names;
		matchedDefs = m.defs;
		remaining = m.remaining;
		matchedDef = commandDef;
	} else {
		const m = matchSubcommand(remaining, commandDef);
		matchedDef = m.def;
		commandChain = m.chain;
		remaining = m.remaining;
	}

	const opts = classifyOptions(remaining, matchedDef);

	const allOverrides = [...globalOverrides, ...opts.overrides];
	const allRiskOverrides = [...globalRiskOverrides, ...opts.riskOverrides];
	const allDirectories = [...stripped.directories, ...opts.directories];

	const fullCommand = [binary, ...commandChain];
	const matchedRule = commandChain.length > 0 ? fullCommand.join(".") : binary;

	const baseClassification = matchedDef.classification ?? "READONLY";
	const baseRisk = matchedDef.risk ?? defaultRisk(baseClassification);
	const riskExplicitlySet = matchedDef.risk !== undefined;

	let finalClassification: Classification;
	let overridingOption: string | null = null;
	let classificationReason: string;

	let allOver = [...allOverrides];
	if (allOver.length > 0) {
		finalClassification = allOver[0][1];
		overridingOption = allOver[0][0];
		for (const [optName, cls] of allOver.slice(1)) {
			if (CLASS_SEV[cls] > CLASS_SEV[finalClassification]) {
				finalClassification = cls;
				overridingOption = optName;
			}
		}
		classificationReason = `overridden by option ${overridingOption} to ${finalClassification}`;
	} else {
		finalClassification = baseClassification;
		classificationReason = `base classification from rule ${matchedRule}`;
	}

	let riskOverrideList = [...allRiskOverrides];
	let finalRisk: Risk;
	if (riskOverrideList.length > 0) {
		finalRisk = riskOverrideList[0][1];
		for (const [, r] of riskOverrideList.slice(1)) {
			if (RISK_SEV[r] > RISK_SEV[finalRisk]) finalRisk = r;
		}
	} else if (allOver.length > 0 && !riskExplicitlySet) {
		finalRisk = defaultRisk(finalClassification);
	} else {
		finalRisk = baseRisk;
	}

	// Global options that appear after the subcommand (e.g. kubectl apply --help).
	if (Object.keys(commandDef.globalOptions).length > 0) {
		for (const opt of [...opts.unknown]) {
			const optKey = opt.includes("=") ? opt.split("=", 1)[0] : opt;
			const globalOptDef = commandDef.globalOptions[optKey];
			if (globalOptDef === undefined) continue;
			opts.unknown.splice(opts.unknown.indexOf(opt), 1);
			if (globalOptDef.overrides !== null) {
				allOver.push([optKey, globalOptDef.overrides]);
				finalClassification = allOver[0][1];
				overridingOption = allOver[0][0];
				for (const [oName, cls] of allOver.slice(1)) {
					if (CLASS_SEV[cls] > CLASS_SEV[finalClassification]) {
						finalClassification = cls;
						overridingOption = oName;
					}
				}
				classificationReason = `overridden by option ${overridingOption} to ${finalClassification}`;
			}
			if (globalOptDef.risk !== null) {
				riskOverrideList.push([optKey, globalOptDef.risk]);
			}
			if (riskOverrideList.length > 0) {
				finalRisk = riskOverrideList[0][1];
				for (const [, r] of riskOverrideList.slice(1)) {
					if (RISK_SEV[r] > RISK_SEV[finalRisk]) finalRisk = r;
				}
			} else if (allOver.length > 0 && !riskExplicitlySet) {
				finalRisk = defaultRisk(finalClassification);
			}
		}
	}

	// match_all aggregation over matched goals.
	if (commandDef.subcommandMode === "match_all" && matchedDefs.length > 0) {
		let aggClass: Classification = "READONLY";
		let aggRisk: Risk = "LOW";
		for (const subDef of matchedDefs) {
			const subClass = subDef.classification ?? "READONLY";
			const subRisk = subDef.risk ?? defaultRisk(subClass);
			aggClass = maxSeverityClass(aggClass, subClass);
			aggRisk = maxSeverityRisk(aggRisk, subRisk);
		}
		if (opts.positional.some((t) => !t.startsWith("-"))) {
			aggRisk = maxSeverityRisk(aggRisk, baseRisk);
		}
		if (allOver.length > 0) {
			finalRisk = maxSeverityRisk(finalRisk, aggRisk);
		} else {
			finalClassification = maxSeverityClass(finalClassification, aggClass);
			finalRisk = aggRisk;
			classificationReason = `base classification from rule ${matchedRule}`;
		}
	}

	// Strict mode: unrecognized options -> UNKNOWN.
	if (matchedDef.strict && opts.unknown.length > 0) {
		finalClassification = maxSeverityClass(finalClassification, "UNKNOWN");
		if (finalClassification === "UNKNOWN") {
			classificationReason = `unrecognized option ${opts.unknown[0]} in strict mode`;
		}
		finalRisk = "HIGH";
	}

	const innerCommands: InnerCommandGrade[] = [];
	let commandLevelInnerCount = 0;

	if (matchedDef.delegatesTo !== undefined) {
		const inner = handleDelegation(opts.positional, matchedDef.delegatesTo, database, argv);
		commandLevelInnerCount = inner.length;
		innerCommands.push(...inner);
	}

	for (const [optName, delegation, tokens] of opts.delegations) {
		innerCommands.push(...handleOptionDelegation(optName, delegation, tokens, database));
	}

	if (commandLevelInnerCount > 0 && allOver.length === 0 && !(matchedDef.strict && opts.unknown.length > 0)) {
		finalClassification = "READONLY";
		finalRisk = "LOW";
		classificationReason = `delegated to inner via ${matchedRule}`;
	}

	for (const inner of innerCommands) {
		if (CLASS_SEV[inner.classification] > CLASS_SEV[finalClassification]) {
			finalClassification = maxSeverityClass(finalClassification, inner.classification);
			classificationReason = "elevated by inner command";
		}
		finalRisk = maxSeverityRisk(finalRisk, inner.risk);
	}

	finalRisk = clampRisk(finalClassification, finalRisk);

	return {
		command: fullCommand,
		argv: [...argv],
		classification: finalClassification,
		risk: finalRisk,
		matchedRule,
		innerCommands,
		ignoredOptions: stripped.ignored.length > 0 ? stripped.ignored : null,
		remainingOptions: opts.unknown.length > 0 ? [...opts.unknown] : null,
		classificationReason,
		overridingOption,
		directories: allDirectories.length > 0 ? allDirectories : null,
		writePaths: null,
		readPaths: null,
	};
}

const CLASS_SEV: Record<Classification, number> = {
	READONLY: 0,
	LOCAL_EFFECTS: 1,
	EXTERNAL_EFFECTS: 2,
	UNKNOWN: 3,
	DANGEROUS: 4,
};
const RISK_SEV: Record<Risk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function emptyGrade(argv: string[], classification: Classification, risk: Risk): CommandGrade {
	return {
		command: argv.length > 0 ? [argv[0]] : [],
		argv: [...argv],
		classification,
		risk,
		matchedRule: null,
		innerCommands: [],
		ignoredOptions: null,
		remainingOptions: null,
		classificationReason: null,
		overridingOption: null,
		directories: null,
		writePaths: null,
		readPaths: null,
	};
}

function builtinGrade(argv: string[], classification: Classification, risk: Risk): CommandGrade {
	return {
		...emptyGrade(argv, classification, risk),
		classificationReason: `shell builtin (always ${classification})`,
	};
}

function stripGlobalOptions(
	argv: string[],
	commandDef: CommandDef,
): {
	remaining: string[];
	ignored: string[];
	directories: string[];
	overrides: [string, Classification][];
	riskOverrides: [string, Risk][];
} {
	if (Object.keys(commandDef.globalOptions).length === 0) {
		return { remaining: [...argv], ignored: [], directories: [], overrides: [], riskOverrides: [] };
	}

	const remaining: string[] = [];
	const ignored: string[] = [];
	const directories: string[] = [];
	const overrides: [string, Classification][] = [];
	const riskOverrides: [string, Risk][] = [];
	let i = 0;

	while (i < argv.length) {
		const token = argv[i];
		if (!token.startsWith("-")) {
			remaining.push(...argv.slice(i));
			break;
		}
		if (token.includes("=")) {
			const key = token.split("=", 1)[0];
			const optDef = commandDef.globalOptions[key];
			if (optDef !== undefined) {
				ignored.push(token);
				if (optDef.capturesDirectory) directories.push(token.slice(key.length + 1));
				if (optDef.overrides !== null) overrides.push([key, optDef.overrides]);
				if (optDef.risk !== null) riskOverrides.push([key, optDef.risk]);
				i += 1;
				continue;
			}
		}
		const optDef = commandDef.globalOptions[token];
		if (optDef !== undefined) {
			ignored.push(token);
			if (optDef.overrides !== null) overrides.push([token, optDef.overrides]);
			if (optDef.risk !== null) riskOverrides.push([token, optDef.risk]);
			if (optDef.takesValue && i + 1 < argv.length) {
				i += 1;
				ignored.push(argv[i]);
				if (optDef.capturesDirectory) directories.push(argv[i]);
			}
			i += 1;
			continue;
		}
		remaining.push(token);
		i += 1;
	}

	return { remaining, ignored, directories, overrides, riskOverrides };
}

function matchSubcommand(argv: string[], commandDef: CommandDef): { def: CommandDef; chain: string[]; remaining: string[] } {
	let def = commandDef;
	const chain: string[] = [];
	const remaining = [...argv];
	while (remaining.length > 0) {
		const token = remaining[0];
		if (token.startsWith("-")) break;
		const next = def.subcommands[token];
		if (next === undefined) break;
		chain.push(token);
		def = next;
		remaining.shift();
	}
	return { def, chain, remaining };
}

function matchAllSubcommands(
	argv: string[],
	commandDef: CommandDef,
): { names: string[]; defs: CommandDef[]; remaining: string[] } {
	const names: string[] = [];
	const defs: CommandDef[] = [];
	const remaining: string[] = [];
	for (const token of argv) {
		if (token.startsWith("-")) {
			remaining.push(token);
		} else if (commandDef.subcommands[token] !== undefined) {
			names.push(token);
			defs.push(commandDef.subcommands[token]);
		} else {
			remaining.push(token);
		}
	}
	return { names, defs, remaining };
}

interface OptionClassification {
	known: string[];
	unknown: string[];
	overrides: [string, Classification][];
	riskOverrides: [string, Risk][];
	directories: string[];
	delegations: [string, NonNullable<OptionDef["delegatesTo"]>, string[]][];
	positional: string[];
}

function classifyOptions(argv: string[], commandDef: CommandDef): OptionClassification {
	const known: string[] = [];
	const unknown: string[] = [];
	const overrides: [string, Classification][] = [];
	const riskOverrides: [string, Risk][] = [];
	const directories: string[] = [];
	const delegations: [string, NonNullable<OptionDef["delegatesTo"]>, string[]][] = [];
	const positional: string[] = [];
	const options = commandDef.options;

	const stopAtFirstPositional = commandDef.delegatesTo?.mode === "rest_are_argv";

	let i = 0;
	let endOfOptions = false;

	while (i < argv.length) {
		const token = argv[i];

		if (token === "--") {
			endOfOptions = true;
			positional.push(token);
			i += 1;
			while (i < argv.length) {
				positional.push(argv[i]);
				i += 1;
			}
			break;
		}

		if (endOfOptions || !token.startsWith("-")) {
			if (stopAtFirstPositional) {
				i += commandDef.delegatesTo?.skipLeadingPositionals ?? 0;
				positional.push(...argv.slice(i));
				break;
			}
			positional.push(token);
			i += 1;
			continue;
		}

		if (token.startsWith("--") && token.includes("=")) {
			const eq = token.indexOf("=");
			const key = token.slice(0, eq);
			const value = token.slice(eq + 1);
			const optDef = options[key];
			if (optDef !== undefined) {
				known.push(token);
				if (optDef.overrides !== null) overrides.push([key, optDef.overrides]);
				if (optDef.risk !== null) riskOverrides.push([key, optDef.risk]);
				if (optDef.capturesDirectory) directories.push(value);
			} else {
				unknown.push(token);
			}
			i += 1;
			continue;
		}

		if (token.startsWith("--")) {
			const optDef = options[token];
			if (optDef !== undefined) {
				known.push(token);
				if (optDef.overrides !== null) overrides.push([token, optDef.overrides]);
				if (optDef.risk !== null) riskOverrides.push([token, optDef.risk]);
				if (optDef.delegatesTo !== undefined) {
					delegations.push([token, optDef.delegatesTo, extractDelegationTokens(argv, i, optDef.delegatesTo)]);
					i = skipDelegationTokens(argv, i, optDef.delegatesTo);
					continue;
				}
				if (optDef.takesValue && i + 1 < argv.length) {
					i += 1;
					known.push(argv[i]);
					if (optDef.capturesDirectory) directories.push(argv[i]);
				}
			} else {
				unknown.push(token);
			}
			i += 1;
			continue;
		}

		// Short options: exact token match first (e.g. -it, -delete, -exec).
		let optDef = options[token];
		if (optDef !== undefined) {
			known.push(token);
			if (optDef.overrides !== null) overrides.push([token, optDef.overrides]);
			if (optDef.risk !== null) riskOverrides.push([token, optDef.risk]);
			if (optDef.delegatesTo !== undefined) {
				delegations.push([token, optDef.delegatesTo, extractDelegationTokens(argv, i, optDef.delegatesTo)]);
				i = skipDelegationTokens(argv, i, optDef.delegatesTo);
				continue;
			}
			if (optDef.takesValue && i + 1 < argv.length) {
				i += 1;
				known.push(argv[i]);
				if (optDef.capturesDirectory) directories.push(argv[i]);
			}
			i += 1;
			continue;
		}

		if (token.length >= 2 && token[0] === "-" && token[1] !== "-") {
			const shortFlag = `-${token[1]}`;
			optDef = options[shortFlag];

			if (optDef !== undefined && optDef.takesValue && token.length > 2) {
				// Joined short option with value: -fvalue
				known.push(token);
				const value = token.slice(2);
				if (optDef.overrides !== null) overrides.push([shortFlag, optDef.overrides]);
				if (optDef.risk !== null) riskOverrides.push([shortFlag, optDef.risk]);
				if (optDef.capturesDirectory) directories.push(value);
				i += 1;
				continue;
			}

			if (optDef !== undefined && !optDef.takesValue && token.length > 2) {
				// Combined short options: -abc -> -a -b -c
				let allKnown = true;
				const pendingOverrides: [string, Classification][] = [];
				const pendingRiskOverrides: [string, Risk][] = [];
				for (let j = 1; j < token.length; j++) {
					const charFlag = `-${token[j]}`;
					const charDef = options[charFlag];
					if (charDef === undefined) {
						allKnown = false;
						break;
					}
					if (charDef.takesValue) {
						if (charDef.overrides !== null) pendingOverrides.push([charFlag, charDef.overrides]);
						if (charDef.risk !== null) pendingRiskOverrides.push([charFlag, charDef.risk]);
						const remainingChars = token.slice(j + 1);
						if (remainingChars) {
							if (charDef.capturesDirectory) directories.push(remainingChars);
						} else if (i + 1 < argv.length) {
							i += 1;
							known.push(argv[i]);
							if (charDef.capturesDirectory) directories.push(argv[i]);
						}
						break;
					}
					if (charDef.overrides !== null) pendingOverrides.push([charFlag, charDef.overrides]);
					if (charDef.risk !== null) pendingRiskOverrides.push([charFlag, charDef.risk]);
				}
				if (allKnown) {
					known.push(token);
					overrides.push(...pendingOverrides);
					riskOverrides.push(...pendingRiskOverrides);
					i += 1;
					continue;
				}
			}

			if (optDef !== undefined) {
				known.push(token);
				if (optDef.overrides !== null) overrides.push([shortFlag, optDef.overrides]);
				if (optDef.risk !== null) riskOverrides.push([shortFlag, optDef.risk]);
				if (optDef.takesValue && i + 1 < argv.length) {
					i += 1;
					known.push(argv[i]);
					if (optDef.capturesDirectory) directories.push(argv[i]);
				}
				i += 1;
				continue;
			}
		}

		unknown.push(token);
		i += 1;
	}

	return { known, unknown, overrides, riskOverrides, directories, delegations, positional };
}

function isTerminator(token: string, terminator: string | null): boolean {
	if (terminator === null) return false;
	return token === terminator || token === `\\${terminator}`;
}

function extractDelegationTokens(argv: string[], optionIndex: number, delegation: NonNullable<OptionDef["delegatesTo"]>): string[] {
	if (delegation.mode !== "terminated_argv") return [];
	const tokens: string[] = [];
	let i = optionIndex + 1;
	while (i < argv.length) {
		if (isTerminator(argv[i], delegation.terminator)) break;
		tokens.push(argv[i]);
		i += 1;
	}
	return tokens;
}

function skipDelegationTokens(argv: string[], optionIndex: number, delegation: NonNullable<OptionDef["delegatesTo"]>): number {
	if (delegation.mode !== "terminated_argv") return optionIndex + 1;
	let i = optionIndex + 1;
	while (i < argv.length) {
		if (isTerminator(argv[i], delegation.terminator)) return i + 1;
		i += 1;
	}
	return argv.length;
}

function handleDelegation(
	remainingPositional: string[],
	delegation: NonNullable<CommandDef["delegatesTo"]>,
	database: Record<string, CommandDef>,
	fullArgv: string[],
): InnerCommandGrade[] {
	const results: InnerCommandGrade[] = [];

	if (delegation.mode === "rest_are_argv") {
		let innerArgv = [...remainingPositional];
		if (delegation.stripAssignments) {
			while (innerArgv.length > 0 && ASSIGNMENT_RE.test(innerArgv[0])) innerArgv = innerArgv.slice(1);
		}
		if (innerArgv.length > 0) {
			results.push(matchInnerCommand(innerArgv, database, delegation.minClassification));
		}
	} else if (delegation.mode === "after_separator") {
		const separator = delegation.separator ?? "--";
		const sepIndex = remainingPositional.indexOf(separator);
		if (sepIndex !== -1) {
			const innerArgv = remainingPositional.slice(sepIndex + 1);
			if (innerArgv.length > 0) {
				results.push(matchInnerCommand(innerArgv, database, delegation.minClassification));
			}
		}
	} else if (delegation.mode === "flag_value_is_expression") {
		const flag = delegation.flag;
		if (flag !== null) {
			const value = findFlagValue(fullArgv, flag);
			if (value !== null) {
				for (const inv of parseInnerExpression(value)) {
					results.push(matchInnerCommand(inv, database, delegation.minClassification));
				}
			}
		}
	}

	return results;
}

/** Overridden at module scope by grade.ts to avoid a dependency cycle. */
let parseInnerExpressionImpl: (expression: string) => string[][] = () => [];

export function registerInnerExpressionParser(parser: (expression: string) => string[][]): void {
	parseInnerExpressionImpl = parser;
}

function parseInnerExpression(expression: string): string[][] {
	try {
		return parseInnerExpressionImpl(expression);
	} catch {
		return [];
	}
}

function handleOptionDelegation(
	_optionName: string,
	delegation: NonNullable<OptionDef["delegatesTo"]>,
	tokens: string[],
	database: Record<string, CommandDef>,
): InnerCommandGrade[] {
	if (delegation.mode !== "terminated_argv") return [];
	const innerArgv = tokens.filter((t) => t !== "{}");
	if (innerArgv.length === 0) return [];
	return [matchInnerCommand(innerArgv, database, delegation.minClassification)];
}

function matchInnerCommand(
	argv: string[],
	database: Record<string, CommandDef>,
	minClassification: Classification | null,
): InnerCommandGrade {
	const inner = matchCommand({ argv, redirects: [], positionInPipeline: 0, pipelineLength: 1, context: "toplevel", operatorBefore: null, isBackground: false }, database);
	let classification = inner.classification;
	let risk = inner.risk;
	if (minClassification !== null) {
		classification = maxSeverityClass(classification, minClassification);
		risk = maxSeverityRisk(risk, defaultRisk(minClassification));
	}
	risk = clampRisk(classification, risk);
	return {
		command: inner.command,
		argv: [...argv],
		classification,
		risk,
		matchedRule: inner.matchedRule,
	};
}

function findFlagValue(argv: string[], flag: string): string | null {
	let value: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === flag && i + 1 < argv.length) {
			value = argv[i + 1];
			break;
		}
		if (token.startsWith(`${flag}=`)) {
			value = token.slice(flag.length + 1);
			break;
		}
	}
	if (value !== null) value = stripQuotes(value);
	return value;
}

function stripQuotes(s: string): string {
	if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
		return s.slice(1, -1);
	}
	return s;
}
