import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { EnvironmentInfo } from "./system-prompt-core.ts";

/**
 * Build the <env> block fields:
 * - cwd:       process working directory
 * - worktree:  git top-level if inside a git repo, otherwise cwd
 * - isGitRepo: true when cwd is inside a git work tree
 * - platform:  process.platform
 *
 * Mirrors opencode's env block. The one intentional deviation: when not in
 * a git repo, opencode sets worktree to "/" whereas we keep it equal to cwd
 * so the root stays a meaningful path.
 */
export function detectEnvironment(cwd: string): EnvironmentInfo {
	const normalized = resolve(cwd);
	let isGitRepo = false;
	let worktree = normalized;

	try {
		const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: normalized,
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1000,
		}).toString().trim();
		if (inside === "true") isGitRepo = true;
	} catch {
		// git missing or timed out — treat as non-git, leave worktree equal to cwd.
	}

	if (isGitRepo) {
		try {
			const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
				cwd: normalized,
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1000,
			}).toString().trim();
			if (toplevel) worktree = toplevel;
		} catch {
			// keep cwd fallback
		}
	}

	return { cwd: normalized, worktree, isGitRepo, platform: process.platform };
}