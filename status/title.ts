/**
 * Terminal Title Module
 *
 * Manages the terminal emulator's tab/window title to show:
 * - Current working directory and session name
 * - Animated braille spinner during agent activity
 * - Tool execution context
 *
 * Uses ctx.ui.setTitle() to update the terminal title.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Spinner frames (shared with working indicator) ──

export const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

// ── State ──

export interface TitleState {
  titleTimer: ReturnType<typeof setInterval> | null;
  frameIndex: number;
  activeCtx: ExtensionContext | null;
}

// ── Title builders ──

function getTitleParts(pi: ExtensionAPI) {
  return {
    cwd: path.basename(process.cwd()),
    session: pi.getSessionName() ?? null,
  };
}

export function buildWorkingTitle(pi: ExtensionAPI, frame: string): string {
  const { cwd, session } = getTitleParts(pi);
  const parts = [`${frame} \u03C0`, cwd];
  if (session) parts.push(session);
  return parts.join(" \u00B7 ");
}

export function buildIdleTitle(pi: ExtensionAPI): string {
  const { cwd, session } = getTitleParts(pi);
  const parts = ["\u03C0", cwd];
  if (session) parts.push(session);
  return parts.join(" \u00B7 ");
}

// ── Herdr tab title ──
// Herdr tab labels are set via its socket API (`herdr tab rename`), independent
// of the OSC terminal title — so ctx.ui.setTitle alone doesn't move the tab.
// When running inside herdr, mirror the STATIC idle title (no working
// spinner/status) into the tab. No-op outside herdr.
const HERDR_TIMEOUT_MS = 800;
let lastHerdrLabel: string | null = null;
export function syncHerdrTabTitle(pi: ExtensionAPI): void {
  const tabId = process.env.HERDR_ENV ? process.env.HERDR_TAB_ID : undefined;
  if (!tabId) return;
  const label = buildIdleTitle(pi);
  if (label === lastHerdrLabel) return;
  lastHerdrLabel = label;
  try {
    execFile("herdr", ["tab", "rename", tabId, label], { timeout: HERDR_TIMEOUT_MS }, () => {});
  } catch { /* best-effort */ }
}

// ── Animation lifecycle ──

export function startTitleAnimation(pi: ExtensionAPI, ctx: ExtensionContext, state: TitleState): void {
  if (state.titleTimer) return;
  state.activeCtx = ctx;
  state.titleTimer = setInterval(() => {
    if (!state.activeCtx) return;
    state.activeCtx.ui.setTitle(buildWorkingTitle(pi, SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length]!));
    state.frameIndex++;
  }, 100);
}

export function stopTitleAnimation(ctx: ExtensionContext, state: TitleState): void {
  if (state.titleTimer) { clearInterval(state.titleTimer); state.titleTimer = null; }
  state.frameIndex = 0;
  state.activeCtx = null;
}

/** Set the terminal title to the current animation frame (without advancing the spinner). */
export function updateTitleFrame(pi: ExtensionAPI, ctx: ExtensionContext, state: TitleState): void {
  ctx.ui.setTitle(buildWorkingTitle(pi, SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length]!));
  state.activeCtx = ctx;
}
