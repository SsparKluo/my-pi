import type { Action, ClassifierConfig } from "./config.ts";

export const DEFAULT_CLASSIFIER_PROMPT = `You are a safety classifier for bash commands in a coding-agent session.
Reply with exactly one word: allow or deny.
deny if the command could destroy data, exfiltrate secrets, escalate privileges, or do something the user did not imply.
allow routine read-only inspection or project-local work.`;

export function parseModelRef(ref: string): { provider: string; modelId: string } | null {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return null;
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export function normalizeCacheKey(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

/** Parse model text into a configured verdict. Both allow+deny → deny. None → fallback. */
export function parseClassifierVerdict(text: string, verdicts: string[], fallback: Action): Action {
	const allowed = new Set(verdicts.map((v) => v.toLowerCase()));
	const found: string[] = [];
	for (const match of text.toLowerCase().matchAll(/\b[a-z]+\b/g)) {
		const word = match[0];
		if (allowed.has(word) && !found.includes(word)) found.push(word);
	}
	if (found.includes("deny")) return "deny";
	if (found.length === 1) {
		const only = found[0];
		if (only === "allow" || only === "deny" || only === "ask" || only === "classify") return only;
	}
	if (found.length > 1) return fallback === "allow" ? "allow" : "deny";
	return fallback;
}

export function mergeClassifierVerdicts(verdicts: Action[], fallback: Action): Action {
	if (verdicts.some((v) => v === "deny")) return "deny";
	if (verdicts.length > 0 && verdicts.every((v) => v === "allow")) return "allow";
	return fallback;
}

export function collectAgentsMd(files: { path: string; content: string }[] | undefined): string {
	if (!files) return "";
	return files
		.filter((f) => /(^|\/)AGENTS\.md$/i.test(f.path.replace(/\\/g, "/")))
		.map((f) => f.content)
		.join("\n\n");
}

export function lastUserTexts(branch: { type: string; message?: { role?: string; content?: unknown } }[]): string[] {
	const texts: string[] = [];
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = contentToText(entry.message.content);
		if (text) texts.push(text);
	}
	return texts.slice(-3);
}

export function buildClassifierUserContent(opts: {
	agentsMd: string;
	userMessages: string[];
	wholeCommand: string;
	target: string;
}): string {
	const parts: string[] = [];
	if (opts.agentsMd.trim()) {
		parts.push("## AGENTS.md", opts.agentsMd.trim());
	}
	if (opts.userMessages.length > 0) {
		parts.push("## Recent user messages", opts.userMessages.map((m, i) => `${i + 1}. ${m}`).join("\n"));
	}
	parts.push("## Full command (context)", opts.wholeCommand);
	parts.push("## Classify this", opts.target);
	return parts.join("\n\n");
}

export interface ClassifierCall {
	systemPrompt: string;
	userContent: string;
}

export async function classifyCommands(opts: {
	config: ClassifierConfig;
	wholeCommand: string;
	targets: string[];
	agentsMd: string;
	userMessages: string[];
	cache: Map<string, Action>;
	complete: (call: ClassifierCall) => Promise<string>;
}): Promise<Action> {
	const targets = opts.targets.length > 0 ? opts.targets : [opts.wholeCommand];
	const systemPrompt = opts.config.prompt?.trim() || DEFAULT_CLASSIFIER_PROMPT;
	const unique: { key: string; target: string }[] = [];
	const seen = new Set<string>();
	for (const target of targets) {
		const key = normalizeCacheKey(target);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push({ key, target });
	}

	const verdicts = await Promise.all(
		unique.map(async ({ key, target }) => {
			if (opts.config.cache) {
				const hit = opts.cache.get(key);
				if (hit) return hit;
			}
			let raw: string;
			try {
				raw = await opts.complete({
					systemPrompt,
					userContent: buildClassifierUserContent({
						agentsMd: opts.agentsMd,
						userMessages: opts.userMessages,
						wholeCommand: opts.wholeCommand,
						target,
					}),
				});
			} catch {
				return opts.config.fallback;
			}
			const verdict = parseClassifierVerdict(raw, opts.config.verdicts, opts.config.fallback);
			if (opts.config.cache) opts.cache.set(key, verdict);
			return verdict;
		}),
	);

	return mergeClassifierVerdicts(verdicts, opts.config.fallback);
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
			return "";
		})
		.join("");
}
