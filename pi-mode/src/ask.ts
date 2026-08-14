import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AskConfig } from "./config.ts";
import { sessionApprovalHint, type PermissionVerdict } from "./permission.ts";

export type AskDecision = "allow_once" | "allow_session" | "deny";

const OPTIONS: { id: AskDecision; label: string; hint: string }[] = [
	{ id: "allow_once", label: "Allow once", hint: "y" },
	{ id: "allow_session", label: "Allow for session", hint: "a · s" },
	{ id: "deny", label: "Deny", hint: "n" },
];

const PAD_X = 1;

export async function showAskDialog(
	ctx: ExtensionContext,
	verdict: PermissionVerdict,
	ask: AskConfig,
): Promise<AskDecision> {
	return ctx.ui.custom<AskDecision>((tui, theme, _kb, done) => {
		const state = {
			collapsed: false,
			scroll: 0,
			selected: 0,
			wrapped: [] as string[],
			wrapWidth: 0,
		};

		function maxBody(): number {
			return Math.max(1, ask.maxBlockHeight);
		}

		function wrapSubject(innerWidth: number): string[] {
			if (innerWidth === state.wrapWidth && state.wrapped.length > 0) return state.wrapped;
			const lines: string[] = [];
			for (const raw of verdict.subject.split("\n")) {
				const chunk = raw.length === 0 ? [""] : wrapTextWithAnsi(raw, Math.max(1, innerWidth));
				lines.push(...chunk);
			}
			state.wrapped = lines;
			state.wrapWidth = innerWidth;
			return lines;
		}

		function clampScroll(total: number, view: number): void {
			const maxScroll = Math.max(0, total - view);
			if (state.scroll > maxScroll) state.scroll = maxScroll;
			if (state.scroll < 0) state.scroll = 0;
		}

		function refresh(): void {
			tui.requestRender();
		}

		function confirm(id: AskDecision): void {
			done(id);
		}

		function handleInput(data: string): void {
			if (matchesKey(data, Key.enter)) {
				const picked = OPTIONS[state.selected];
				if (picked) confirm(picked.id);
				return;
			}
			if (matchesKey(data, "y") || data === "Y") {
				confirm("allow_once");
				return;
			}
			if (matchesKey(data, "a") || matchesKey(data, "s") || data === "A" || data === "S") {
				confirm("allow_session");
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, "n") || data === "N") {
				confirm("deny");
				return;
			}
			if (matchesKey(data, Key.ctrl("]"))) {
				state.collapsed = !state.collapsed;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				state.selected = Math.min(OPTIONS.length - 1, state.selected + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.up)) {
				state.selected = Math.max(0, state.selected - 1);
				refresh();
				return;
			}
			if (!state.collapsed) {
				if (matchesKey(data, Key.ctrl("j"))) {
					state.scroll += 1;
					refresh();
					return;
				}
				if (matchesKey(data, Key.ctrl("k"))) {
					state.scroll -= 1;
					refresh();
				}
			}
		}

		function render(width: number): string[] {
			const contentW = Math.max(24, width - PAD_X * 2);
			const innerW = Math.max(1, contentW - 2);
			const all = wrapSubject(innerW);
			const overflowing = all.length > maxBody();
			const lines: string[] = [];
			const push = (text: string) => lines.push(indent(text));
			const pushBlock = (text: string) => {
				lines.push(indent(fill(theme, "toolPendingBg", text, contentW)));
			};

			lines.push("");
			const kind = verdict.kind === "path" ? " · path" : "";
			push(`${theme.fg("toolTitle", theme.bold("ask"))} ${theme.fg("muted", `· ${verdict.surface}${kind}`)}`);
			lines.push("");

			pushBlock("");
			if (state.collapsed) {
				const preview = truncateToWidth(all[0] ?? "", innerW, "…");
				pushBlock(theme.fg("mdCodeBlock", ` ${preview}`));
				const fold = overflowing ? ` folded · ${all.length} lines` : " folded";
				pushBlock(theme.fg("muted", ` ${fold.trim()}`));
			} else {
				const view = Math.min(maxBody(), all.length);
				clampScroll(all.length, view);
				const slice = all.slice(state.scroll, state.scroll + view);
				for (const row of slice) {
					pushBlock(theme.fg("mdCodeBlock", ` ${row}`));
				}
				if (overflowing) {
					const from = state.scroll + 1;
					const to = state.scroll + slice.length;
					pushBlock(theme.fg("muted", ` ${from}–${to}/${all.length}  Ctrl+j k`));
				}
			}
			pushBlock("");

			lines.push("");

			const hint = sessionApprovalHint(verdict, ctx.cwd);
			const fitted = fitHint(hint, Math.max(16, contentW - 36));

			for (let i = 0; i < OPTIONS.length; i++) {
				const opt = OPTIONS[i];
				const selected = i === state.selected;
				const marker = selected ? "→ " : "  ";
				const showCache = opt.id === "allow_session" && fitted.plain.length > 0;
				const leftPlain = marker + opt.label + (showCache ? `  ${fitted.plain}` : "");
				if (selected) {
					const inner = spread(leftPlain, opt.hint, contentW - 2);
					lines.push(indent(fill(theme, "selectedBg", theme.fg("accent", ` ${inner}`), contentW)));
				} else {
					const label = theme.fg("text", marker + opt.label);
					const cache = showCache ? `  ${fitted.styled(theme)}` : "";
					const gap = spreadGap(leftPlain, opt.hint, contentW - 2);
					push(pad(` ${label}${cache}${" ".repeat(gap)}${theme.fg("dim", opt.hint)}`, contentW));
				}
			}

			lines.push("");
			push(theme.fg("dim", "↑↓ select  ·  Enter confirm  ·  Ctrl+] fold"));
			lines.push("");
			return lines;
		}

		return {
			render,
			invalidate: () => {
				state.wrapped = [];
				state.wrapWidth = 0;
			},
			handleInput,
		};
	});
}

function fitHint(
	hint: ReturnType<typeof sessionApprovalHint>,
	budget: number,
): { plain: string; styled: (theme: Theme) => string } {
	const per = Math.max(8, Math.floor(budget / Math.max(2, hint.targets.length + 1)));
	const tool = truncateToWidth(hint.tool, per, "…");
	const targets = hint.targets.map((t) => ({
		...t,
		display: truncateToWidth(t.display, per, "…"),
	}));
	const anyExternal = targets.some((t) => t.external);
	const bits = [tool, ...targets.map((t) => t.display), ...(anyExternal ? ["external"] : [])];
	const plain = bits.filter(Boolean).join("  ·  ");
	return {
		plain,
		styled: (theme) => {
			const parts = [theme.fg("muted", tool)];
			for (const t of targets) {
				parts.push(theme.fg(t.external ? "warning" : "muted", t.display));
			}
			if (anyExternal) parts.push(theme.fg("warning", "external"));
			return parts.join(theme.fg("dim", "  ·  "));
		},
	};
}

function indent(text: string): string {
	return `${" ".repeat(PAD_X)}${text}`;
}

function spreadGap(left: string, right: string, innerW: number): number {
	return Math.max(1, innerW - visibleWidth(left) - visibleWidth(right));
}

function spread(left: string, right: string, innerW: number): string {
	return `${left}${" ".repeat(spreadGap(left, right, innerW))}${right}`;
}

function fill(theme: Theme, bg: "selectedBg" | "toolPendingBg", text: string, width: number): string {
	return theme.bg(bg, pad(text, width));
}

function pad(text: string, width: number): string {
	const n = visibleWidth(text);
	if (n >= width) return truncateToWidth(text, width);
	return text + " ".repeat(width - n);
}
