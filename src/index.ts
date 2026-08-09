import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-mode — a configurable mode-switcher extension for the pi coding agent.
 *
 * Modes bundle a permission policy (flat format: allow/deny/ask/classify per
 * surface), enter/exit/per-turn prompts, and (for `classify`) an AI bash
 * classifier. Mode state persists per session and changes are broadcast so UI
 * components can react.
 *
 * Built up incrementally per layer. Layer 0: scaffold only.
 */
export default function piMode(_pi: ExtensionAPI): void {
  // Wired up in subsequent layers.
}
