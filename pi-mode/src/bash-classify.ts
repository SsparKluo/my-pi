import { spawn } from "node:child_process";
import type { Action, BashClass, BashRisk, ClassifyMap, GradeAction } from "./config.ts";

export interface BashClassifyResult {
	classification: BashClass | string;
	risk: BashRisk | string;
	expression?: string;
}

export type BashClassifyRunner = (command: string) => Promise<BashClassifyResult>;

const ACTION_RANK: Record<Action, number> = { deny: 3, ask: 2, classify: 2, allow: 1 };

const DEFAULT_BY_RISK: Record<string, GradeAction> = { LOW: "allow", MEDIUM: "ask", HIGH: "ask" };

/** Class map wins when present; otherwise risk; otherwise fallback. */
export function mapBashClassifyAction(
	result: BashClassifyResult,
	maps: ClassifyMap,
	fallback: GradeAction = "ask",
): GradeAction {
	const classAction = maps.byClass?.[result.classification as BashClass];
	if (classAction) return classAction;
	const riskAction = maps.byRisk?.[result.risk as BashRisk] ?? DEFAULT_BY_RISK[result.risk];
	return riskAction ?? fallback;
}

export function mergeClassifyMaps(global: ClassifyMap, mode?: ClassifyMap): ClassifyMap {
	return {
		byRisk: { ...global.byRisk, ...mode?.byRisk },
		byClass: { ...global.byClass, ...mode?.byClass },
	};
}

export function mostRestrictiveAction(actions: Action[], fallback: Action): Action {
	if (actions.length === 0) return fallback;
	return actions.reduce((a, b) => ((ACTION_RANK[b] ?? 0) > (ACTION_RANK[a] ?? 0) ? b : a));
}

export function parseBashClassifyJson(raw: string): BashClassifyResult {
	const parsed = JSON.parse(raw) as Partial<BashClassifyResult>;
	const classification = typeof parsed.classification === "string" ? parsed.classification : "UNKNOWN";
	const risk = typeof parsed.risk === "string" ? parsed.risk : "HIGH";
	return { classification, risk, expression: parsed.expression };
}

const RUN_TIMEOUT_MS = 8000;

export function createBashClassifyRunner(command: string): BashClassifyRunner {
	const argv = command.trim().split(/\s+/).filter(Boolean);
	const bin = argv[0] ?? "bash-classify";
	const args = argv.slice(1);
	return (expression) =>
		new Promise((resolve, reject) => {
			const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("bash-classify timed out"));
			}, RUN_TIMEOUT_MS);
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code !== 0) {
					reject(new Error(stderr.trim() || `bash-classify exited ${code}`));
					return;
				}
				try {
					resolve(parseBashClassifyJson(stdout));
				} catch (err) {
					reject(err);
				}
			});
			child.stdin.end(expression, "utf8");
		});
}

export async function gradeBashUnits(
	targets: string[],
	maps: ClassifyMap,
	fallback: GradeAction,
	run: BashClassifyRunner,
): Promise<{ unit: string; action: GradeAction }[]> {
	const out: { unit: string; action: GradeAction }[] = [];
	for (const unit of targets) {
		try {
			const result = await run(unit);
			out.push({ unit, action: mapBashClassifyAction(result, maps, fallback) });
		} catch {
			out.push({ unit, action: fallback });
		}
	}
	return out;
}

export async function classifyBashCommands(
	targets: string[],
	maps: ClassifyMap,
	fallback: GradeAction,
	run: BashClassifyRunner,
): Promise<Action> {
	const graded = await gradeBashUnits(targets, maps, fallback, run);
	return mostRestrictiveAction(
		graded.map((g) => (g.action === "model" ? "ask" : g.action)),
		fallback === "model" ? "ask" : fallback,
	);
}
