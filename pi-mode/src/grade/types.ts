export type Classification = "READONLY" | "LOCAL_EFFECTS" | "EXTERNAL_EFFECTS" | "DANGEROUS" | "UNKNOWN";
export type Risk = "LOW" | "MEDIUM" | "HIGH";

export const CLASS_SEVERITY: Record<Classification, number> = {
	READONLY: 0,
	LOCAL_EFFECTS: 1,
	EXTERNAL_EFFECTS: 2,
	UNKNOWN: 3,
	DANGEROUS: 4,
};

export const RISK_SEVERITY: Record<Risk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function maxSeverityClass(a: Classification, b: Classification): Classification {
	return CLASS_SEVERITY[b] > CLASS_SEVERITY[a] ? b : a;
}

export function maxSeverityRisk(a: Risk, b: Risk): Risk {
	return RISK_SEVERITY[b] > RISK_SEVERITY[a] ? b : a;
}

export function defaultRisk(classification: Classification): Risk {
	if (classification === "DANGEROUS" || classification === "UNKNOWN") return "HIGH";
	if (classification === "READONLY") return "LOW";
	return "MEDIUM";
}

export function clampRisk(classification: Classification, risk: Risk): Risk {
	if (classification === "DANGEROUS" || classification === "UNKNOWN") return "HIGH";
	return risk;
}

export interface DelegationConfig {
	mode: "rest_are_argv" | "after_separator" | "terminated_argv" | "flag_value_is_expression";
	separator: string | null;
	terminator: string | null;
	flag: string | null;
	stripAssignments: boolean;
	skipLeadingPositionals: number;
	minClassification: Classification | null;
}

export interface OptionDef {
	takesValue: boolean;
	overrides: Classification | null;
	risk: Risk | null;
	capturesDirectory: boolean;
	delegatesTo: DelegationConfig | undefined;
}

export interface CommandDef {
	command: string;
	aliasOf: string | null;
	classification: Classification | null;
	risk: Risk | undefined;
	strict: boolean;
	subcommandMode: "hierarchical" | "match_all";
	globalOptions: Record<string, OptionDef>;
	options: Record<string, OptionDef>;
	subcommands: Record<string, CommandDef>;
	delegatesTo: DelegationConfig | undefined;
}

export interface Redirect {
	operator: string;
	target: string;
	affectsClassification: boolean;
}

/** A single command invocation extracted from the parsed bash AST. */
export interface Invocation {
	argv: string[];
	redirects: Redirect[];
	positionInPipeline: number;
	pipelineLength: number;
	context: "toplevel" | "subshell" | "command_substitution" | "process_substitution";
	operatorBefore: string | null;
	isBackground: boolean;
}

export interface CommandGrade {
	command: string[];
	argv: string[];
	classification: Classification;
	risk: Risk;
	matchedRule: string | null;
	innerCommands: InnerCommandGrade[];
	ignoredOptions: string[] | null;
	remainingOptions: string[] | null;
	classificationReason: string | null;
	overridingOption: string | null;
	directories: string[] | null;
	writePaths: string[] | null;
	readPaths: string[] | null;
}

export interface InnerCommandGrade {
	command: string[];
	argv: string[];
	classification: Classification;
	risk: Risk;
	matchedRule: string | null;
}

export interface ExpressionGrade {
	expression: string;
	classification: Classification;
	risk: Risk;
	commands: CommandGrade[];
}
