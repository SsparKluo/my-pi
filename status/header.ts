/**
 * Status Header Widget Module
 *
 * Renders a compact identity line (provider/model + thinking, cwd, git).
 * Shown in the footer below the editor, above the context/token line.
 *
 * Token stats, cache rate, and TPS live elsewhere (footer context line /
 * worked-for) — see status/index.ts. Also provides the /statusline helpers.
 */

import path from "node:path";
import fs from "node:fs";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
    ExtensionAPI,
    ExtensionContext,
    Theme,
    ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { GitStatus } from "./git.ts";

// ── Thinking level → theme color ──

const THINKING_LEVEL_COLORS: Record<string, ThemeColor> = {
    off: "thinkingOff",
    minimal: "thinkingMinimal",
    low: "thinkingLow",
    medium: "thinkingMedium",
    high: "thinkingHigh",
    xhigh: "thinkingXhigh",
    max: "thinkingMax",
};

// ── Token formatting (mirrors pi's built-in footer) ──

export function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
    if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    return `${Math.round(count / 1_000_000)}M`;
}

// ── Status line config ──

export interface StatusLineConfig {
    model: boolean;
    currentDir: boolean;
    gitBranch: boolean;
    tokenStats: boolean;
    cacheRate: boolean;
    tokenUsage: boolean;
    tokenSpeed: boolean;
    ttft: boolean;
    thinking: boolean;
}

export const DEFAULT_STATUS_CONFIG: StatusLineConfig = {
    model: true,
    currentDir: true,
    gitBranch: true,
    tokenStats: true,
    cacheRate: true,
    tokenUsage: true,
    tokenSpeed: true,
    ttft: true,
    thinking: true,
};

const STATUS_CONFIG_PATH = path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".pi",
    "agent",
    "statusline-config.json",
);

export function loadStatusConfig(): StatusLineConfig {
    try {
        const raw = fs.readFileSync(STATUS_CONFIG_PATH, "utf-8");
        return { ...DEFAULT_STATUS_CONFIG, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_STATUS_CONFIG };
    }
}

export function saveStatusConfig(config: StatusLineConfig): void {
    try {
        fs.mkdirSync(path.dirname(STATUS_CONFIG_PATH), { recursive: true });
        fs.writeFileSync(
            STATUS_CONFIG_PATH,
            JSON.stringify(config, null, 2),
            "utf-8",
        );
    } catch {
        /* silent */
    }
}

// ── Token stats (matches pi's built-in footer logic) ──

export interface TokenStats {
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheWrite: number;
}

/**
 * Compute cumulative token stats from ALL session entries,
 * mirroring pi's built-in footer logic exactly.
 */
export function computeTokenStats(ctx: ExtensionContext): TokenStats {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    try {
        for (const entry of ctx.sessionManager.getEntries()) {
            if (
                entry.type === "message" &&
                entry.message?.role === "assistant" &&
                entry.message.usage
            ) {
                totalInput += entry.message.usage.input || 0;
                totalOutput += entry.message.usage.output || 0;
                totalCacheRead += entry.message.usage.cacheRead || 0;
                totalCacheWrite += entry.message.usage.cacheWrite || 0;
            }
        }
    } catch {
        /* session not ready */
    }
    return { totalInput, totalOutput, totalCacheRead, totalCacheWrite };
}

/**
 * Compute per-turn token usage + cache hit rate across ALL assistant messages
 * produced during the turn that began at entry index `startIndex`.
 *
 * A single user turn can span multiple provider requests — each tool call
 * triggers a follow-up request, and retries re-run the turn — each emitting its
 * own assistant entry with its own usage. Summing input/output/cacheRead /
 * cacheWrite across all of them yields the turn's true totals; the cache rate is
 * the aggregate totalCacheRead / (totalCacheRead + totalInput), not just the
 * final request's.
 *
 * Returns null when no assistant usage was recorded in the turn.
 */
export function computeTurnStats(
    ctx: ExtensionContext,
    startIndex: number,
): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheRate: number | null;
} | null {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let found = false;
    try {
        const entries = ctx.sessionManager.getEntries();
        for (let i = Math.max(0, startIndex); i < entries.length; i++) {
            const entry = entries[i];
            if (
                entry.type === "message" &&
                entry.message?.role === "assistant" &&
                entry.message.usage
            ) {
                const u = entry.message.usage;
                input += u.input || 0;
                output += u.output || 0;
                cacheRead += u.cacheRead || 0;
                cacheWrite += u.cacheWrite || 0;
                found = true;
            }
        }
    } catch {
        /* session not ready */
    }
    if (!found) return null;
    const denom = cacheRead + input;
    const cacheRate = denom > 0 ? cacheRead / denom : null;
    return { input, output, cacheRead, cacheWrite, cacheRate };
}

// ── Status header rendering ──

export interface HeaderRenderData {
    gitStatus: GitStatus | null;
    /** Active pi-mode label (e.g. "◆ plan"), already styled. Always set once a mode is active. */
    piModeStatus?: string;
}

/**
 * Build the status header lines (single line) for the footer.
 * Uses the same token stats computation as pi's built-in footer.
 */
export function buildStatusHeader(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    data: HeaderRenderData,
    config: StatusLineConfig,
    theme: Theme,
): string[] {
    const parts: string[] = [];
    const sep = theme.fg("borderMuted", " \u2502 ");

    // 0. Active pi-mode (e.g. ◆ plan)
    if (data.piModeStatus) {
        parts.push(data.piModeStatus);
    }

    // 1. Model + thinking:  openai gpt-5.5 low
    if (config.model && ctx.model) {
        let modelPart = theme.fg("accent", `\uEE9C ${ctx.model.provider} ${ctx.model.id}`);
        if (config.thinking && ctx.model.reasoning) {
            const level = pi.getThinkingLevel();
            const thinkColor = THINKING_LEVEL_COLORS[level] ?? "thinkingText";
            modelPart += ` ${theme.fg(thinkColor, level)}`;
        }
        parts.push(modelPart);
    }

    // 2. Working directory:  /path
    if (config.currentDir) {
        let dir = ctx.cwd;
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && dir.startsWith(home)) dir = `~${dir.slice(home.length)}`;
        parts.push(theme.fg("success", `\uF07C ${dir}`));
    }

    // 3. Git branch + badges:  main ↑2 ↓1 +5 ?3
    if (config.gitBranch && data.gitStatus) {
        const git = data.gitStatus;
        let branchStr = `\uF418 ${git.branch}`;
        const badges: string[] = [];
        // ahead: ↑N green
        if (git.ahead > 0)
            badges.push(theme.fg("success", `\u2191${git.ahead}`));
        // behind: ↓N red
        if (git.behind > 0)
            badges.push(theme.fg("error", `\u2193${git.behind}`));
        // changed (staged + modified + deleted + conflicted): +N yellow
        const changed =
            git.staged + git.modified + git.deleted + git.conflicted;
        if (changed > 0) badges.push(theme.fg("warning", `+${changed}`));
        // untracked: ?N red
        if (git.untracked > 0)
            badges.push(theme.fg("error", `?${git.untracked}`));
        if (badges.length > 0) branchStr += " " + badges.join(" ");
        parts.push(theme.fg("text", branchStr));
    }

    if (parts.length === 0) return [""];
    const line = parts.join(sep);
    return [line];
}

// ── Status line config items (for /statusline command) ──

export const STATUSLINE_ITEMS: Array<{
    id: keyof StatusLineConfig;
    label: string;
    description: string;
}> = [
    { id: "model", label: "model", description: "Current model" },
    {
        id: "currentDir",
        label: "current-dir",
        description: "Current working directory with git branch",
    },
    {
        id: "gitBranch",
        label: "git-branch",
        description: "Git branch in path label",
    },
    {
        id: "tokenStats",
        label: "token-stats",
        description: "Input/output/cache token counts (footer)",
    },
    {
        id: "cacheRate",
        label: "cache-rate",
        description: "Cache hit rate: cumulative (footer) + last (worked-for)",
    },
    {
        id: "tokenUsage",
        label: "token-usage",
        description: "Per-turn token usage (worked-for line)",
    },
    {
        id: "tokenSpeed",
        label: "token-speed",
        description: "Token generation speed (worked-for line)",
    },
    { id: "ttft", label: "ttft", description: "Time to first token (worked-for line)" },
    { id: "thinking", label: "thinking", description: "Thinking level" },
];
