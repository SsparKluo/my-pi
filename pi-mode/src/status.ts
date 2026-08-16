/** Icon prefixing the pi-mode status block. Mode-agnostic — it marks the block, not the mode. */
const MODE_ICON = "◆";

/** Mode names shown red: hands-off (classifier-driven or ungated). */
const HANDS_OFF_MODES = new Set(["auto", "full", "yolo"]);

/** Mode names shown yellow: write-restricted. */
const RESTRICTED_MODES = new Set(["plan", "restrict"]);

/** Footer text + theme color token for the active mode. Unlisted names stay neutral. */
export function modeStatus(mode: string): { text: string; color: "error" | "warning" | "accent" } {
	const color = HANDS_OFF_MODES.has(mode) ? "error" : RESTRICTED_MODES.has(mode) ? "warning" : "accent";
	return { text: `${MODE_ICON} ${mode}`, color };
}
