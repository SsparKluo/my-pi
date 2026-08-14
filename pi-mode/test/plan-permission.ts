import type { PermissionRules } from "../src/config.ts";

/** Plan-mode allowlist used by bash/permission tests (not a shipped default). */
export const PLAN_PERMISSION: PermissionRules = {
	"*": "ask",
	read: "allow",
	grep: "allow",
	find: "allow",
	ls: "allow",
	write: { "*": "deny", "**/*.md": "allow" },
	edit: { "*": "deny", "**/*.md": "allow" },
	bash: {
		"*": "deny",
		ls: "allow",
		"ls *": "allow",
		"cat *": "allow",
		"head *": "allow",
		"tail *": "allow",
		"grep *": "allow",
		"rg *": "allow",
		"find *": "allow",
		"fd *": "allow",
		"git status": "allow",
		"git diff *": "allow",
		"git log *": "allow",
		"git branch": "allow",
		"git show *": "allow",
		pwd: "allow",
		"tree *": "allow",
		"wc *": "allow",
	},
};
