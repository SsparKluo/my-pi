import dbRaw from "./commands.json" with { type: "json" };
import type { OptionDef, CommandDef, Classification, DelegationConfig, Risk } from "./types.ts";

/**
 * Load the bash-classify command database.
 * Port of database.py: applies defaults and expands option aliases so
 * lookup works by any name.
 */
const CLASSIFICATIONS = new Set(["READONLY", "LOCAL_EFFECTS", "EXTERNAL_EFFECTS", "DANGEROUS", "UNKNOWN"]);
const RISKS = new Set(["LOW", "MEDIUM", "HIGH"]);

function asClassification(v: unknown): Classification | undefined {
	return typeof v === "string" && CLASSIFICATIONS.has(v) ? (v as Classification) : undefined;
}

function asRisk(v: unknown): Risk | undefined {
	return typeof v === "string" && RISKS.has(v) ? (v as Risk) : undefined;
}

interface RawDelegation {
	mode: string;
	separator?: string;
	terminator?: string;
	flag?: string;
	strip_assignments?: boolean;
	skip_leading_positionals?: number;
	min_classification?: string;
}

function loadDelegation(raw: RawDelegation | undefined): DelegationConfig | undefined {
	if (!raw || typeof raw.mode !== "string") return undefined;
	return {
		mode: raw.mode as DelegationConfig["mode"],
		separator: raw.separator ?? null,
		terminator: raw.terminator ?? null,
		flag: raw.flag ?? null,
		stripAssignments: !!raw.strip_assignments,
		skipLeadingPositionals: raw.skip_leading_positionals ?? 0,
		minClassification: asClassification(raw.min_classification) ?? null,
	};
}

interface RawOption {
	takes_value?: boolean;
	aliases?: string[];
	overrides?: string;
	risk?: string;
	captures_directory?: boolean;
	delegates_to?: RawDelegation;
}

function loadOptions(raw: Record<string, RawOption> | undefined): Record<string, OptionDef> {
	const out: Record<string, OptionDef> = {};
	if (!raw) return out;
	for (const [name, propsRaw] of Object.entries(raw)) {
		const props = propsRaw ?? {};
		const def: OptionDef = {
			takesValue: !!props.takes_value,
			overrides: asClassification(props.overrides) ?? null,
			risk: asRisk(props.risk) ?? null,
			capturesDirectory: !!props.captures_directory,
			delegatesTo: loadDelegation(props.delegates_to as RawDelegation | undefined),
		};
		out[name] = def;
		// Expand aliases so lookup works by any name (database.py behavior).
		for (const alias of props.aliases ?? []) {
			out[alias] = def;
		}
	}
	return out;
}

interface RawCommandDef {
	command: string;
	alias_of?: string;
	classification?: string;
	risk?: string;
	strict?: boolean;
	subcommand_mode?: string;
	global_options?: Record<string, RawOption>;
	options?: Record<string, RawOption>;
	subcommands?: Record<string, RawCommandDef>;
	delegates_to?: RawDelegation;
}

function loadCommand(raw: RawCommandDef): CommandDef {
	return {
		command: raw.command,
		aliasOf: raw.alias_of ?? null,
		classification: asClassification(raw.classification) ?? null,
		risk: asRisk(raw.risk),
		strict: raw.strict ?? true,
		subcommandMode: raw.subcommand_mode === "match_all" ? "match_all" : "hierarchical",
		globalOptions: loadOptions(raw.global_options),
		options: loadOptions(raw.options),
		subcommands: Object.fromEntries(Object.entries(raw.subcommands ?? {}).map(([k, v]) => [k, loadCommand(v)])),
		delegatesTo: loadDelegation(raw.delegates_to),
	};
}

export const COMMAND_DB: Record<string, CommandDef> = Object.fromEntries(
	Object.entries(dbRaw as unknown as Record<string, RawCommandDef>).map(([name, raw]) => [name, loadCommand(raw)]),
);
