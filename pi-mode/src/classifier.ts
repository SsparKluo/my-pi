import type { Action, ModelClassifierConfig } from "./config.ts";

export const DEFAULT_CLASSIFIER_PROMPT = `You are a safety classifier for bash commands in a coding-agent session.
Reply with exactly one word from the allowed verdicts listed in the user message.
deny if the command could destroy data, exfiltrate secrets, escalate privileges, or do something the user did not imply.
allow routine read-only inspection or project-local work.
ask only if ask is an allowed verdict and you cannot decide.`;

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

/** Join whatever context files pi already loaded (AGENTS.md / CLAUDE.md / overrides). */
export function collectAgentsMd(files: { path: string; content: string }[] | undefined): string {
	if (!files?.length) return "";
	return files.map((f) => f.content).join("\n\n");
}

const AGENT_REPLY_CAP = 2000;

export interface ConversationWindow {
	previousUser?: string;
	previousAssistant?: string;
	currentUser?: string;
}

/** Previous user + last assistant text (capped) + current user. Ignores the in-progress turn. */
export function conversationWindow(
	branch: { type: string; message?: { role?: string; content?: unknown } }[],
): ConversationWindow {
	const msgs: { role: "user" | "assistant"; text: string }[] = [];
	for (const entry of branch) {
		const role = entry.message?.role;
		if (entry.type !== "message" || !entry.message || (role !== "user" && role !== "assistant")) continue;
		const text = contentToText(entry.message.content);
		if (text) msgs.push({ role, text });
	}
	let lastUser = -1;
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (msgs[i].role === "user") {
			lastUser = i;
			break;
		}
	}
	if (lastUser < 0) return {};
	const out: ConversationWindow = { currentUser: msgs[lastUser].text };
	for (let i = lastUser - 1; i >= 0; i--) {
		if (!out.previousAssistant && msgs[i].role === "assistant") {
			out.previousAssistant = tail(msgs[i].text, AGENT_REPLY_CAP);
			continue;
		}
		if (msgs[i].role === "user") {
			out.previousUser = msgs[i].text;
			break;
		}
	}
	return out;
}

function tail(text: string, cap: number): string {
	return text.length <= cap ? text : text.slice(-cap);
}

export function buildClassifierUserContent(opts: {
	agentsMd: string;
	conversation: ConversationWindow;
	wholeCommand: string;
	target: string;
	verdicts?: string[];
}): string {
	const parts: string[] = [];
	if (opts.agentsMd.trim()) {
		parts.push("## AGENTS.md", opts.agentsMd.trim());
	}
	const lines: string[] = [];
	if (opts.conversation.previousUser) lines.push(`user: ${opts.conversation.previousUser}`);
	if (opts.conversation.previousAssistant) lines.push(`assistant: ${opts.conversation.previousAssistant}`);
	if (opts.conversation.currentUser) lines.push(`user: ${opts.conversation.currentUser}`);
	if (lines.length > 0) parts.push("## Conversation", lines.join("\n"));
	parts.push("## Full command (context)", opts.wholeCommand);
	parts.push("## Classify this", opts.target);
	const verdicts = opts.verdicts?.length ? opts.verdicts : ["allow", "deny"];
	parts.push("## Allowed verdicts (reply with exactly one)", verdicts.join(" | "));
	return parts.join("\n\n");
}

export interface ClassifierCall {
	systemPrompt: string;
	userContent: string;
}

export async function classifyCommands(opts: {
	config: ModelClassifierConfig;
	wholeCommand: string;
	targets: string[];
	agentsMd: string;
	conversation: ConversationWindow;
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
						conversation: opts.conversation,
						wholeCommand: opts.wholeCommand,
						target,
						verdicts: opts.config.verdicts,
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
