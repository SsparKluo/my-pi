export const STATE_ENTRY = "pi-mode-state";

type StateEntryLike = { type: string; customType?: string; data?: unknown };

/**
 * Find the mode persisted on the active branch. `branch` is the entry path
 * from root to leaf (SessionManager.getBranch()); the most recent
 * pi-mode-state entry on that path is authoritative. Returns undefined when
 * the entry is missing or its data is malformed (caller falls back to
 * defaultMode).
 */
export function findPersistedMode(branch: StateEntryLike[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
			const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
			return typeof mode === "string" ? mode : undefined;
		}
	}
	return undefined;
}

/**
 * The mode the active branch is in: its persisted state when the name still
 * exists in the config (internal modes included), else defaultMode. Shared by
 * session_start (resume) and session_tree (navigation) so both re-derive from
 * the branch the same way.
 */
export function resolveBranchMode(
	branch: StateEntryLike[],
	modes: Record<string, unknown>,
	defaultMode: string,
): string {
	const persisted = findPersistedMode(branch);
	return persisted && modes[persisted] !== undefined ? persisted : defaultMode;
}
