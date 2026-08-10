/**
 * Startup Header Extension
 *
 * A pi-cc-header–style startup header for pi: an animated pixel-art Pi logo on
 * the left with a compact info panel on the right (version, cwd, resource
 * counts, and the ctrl+o hint). Stripped to essentials — no model/effort line,
 * no slogan, no config commands.
 *
 * Like pi-cc-header, this sets quietStartup so pi's verbose native
 * loaded-resources panel is suppressed. ctrl+o expands the header to show the
 * detailed loaded-resources breakdown (context files, skills by scope,
 * extensions, prompts) — computed via a best-effort filesystem scan mirroring
 * pi's own discovery rules.
 *
 * Logo animation adapted from pi.dev/install.sh (via pi-cc-header).
 */

import {
    VERSION,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Dirent, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

// ── Logo visual defaults (pi accent teal #8abeb7; Minecraft gradient on, IBM stripes off) ──
const LOGO_COLOR_KEY = "t";
const GRADIENT_ON = true;       // Minecraft-style: 4-level truecolor gradient
const STRIPE_ENABLED = false;   // IBM-style horizontal stripes (── background)
const LOGO_INTERVAL = 50; // ms per frame

// ── Paths ──
const HOME = homedir();
const AGENT_DIR = join(HOME, ".pi", "agent");
const NPM_MODULES = join(AGENT_DIR, "npm", "node_modules");
const GIT_ROOT = join(AGENT_DIR, "git");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const CONFIG_DIR_NAME = ".pi";

/* ════════════ Logo engine (ported from pi-cc-header / pi.dev install.sh) ════════════ */

const LOGO_COLS = 8;
const LOGO_ROWS = 7;
const LOGO_PIXEL_WIDTH = 14; // 8×2 double-width cells incl. side margins

const CMAP: Record<string, string> = {
    a: "38;2;217;119;87", r: "31", o: "38;5;208", y: "38;5;226",
    g: "38;2;20;180;20", w: "38;5;15", b: "38;2;40;130;220", p: "38;5;129", t: "38;2;138;190;183",
};
const GMAP: Record<string, string[]> = {
    a: ["38;2;217;119;87", "38;2;200;100;70", "38;2;170;80;55", "38;2;130;60;40"],
    r: ["38;2;255;80;80", "38;2;220;40;40", "38;2;180;20;20", "38;2;140;10;10"],
    o: ["38;2;255;170;50", "38;2;230;140;30", "38;2;200;110;20", "38;2;160;80;10"],
    y: ["38;2;255;255;80", "38;2;230;230;40", "38;2;200;200;20", "38;2;160;160;10"],
    g: ["38;2;80;255;80", "38;2;40;220;40", "38;2;20;180;20", "38;2;10;140;10"],
    w: ["38;2;230;230;210", "38;2;190;190;170", "38;2;140;140;120", "38;2;100;100;85"],
    b: ["38;2;100;180;255", "38;2;70;160;245", "38;2;40;130;220", "38;2;20;100;195"],
    p: ["38;2;200;100;255", "38;2;170;70;230", "38;2;140;40;200", "38;2;110;20;160"],
    t: ["38;2;175;210;204", "38;2;138;190;183", "38;2;105;165;158", "38;2;75;135;128"],
};
const GRADIENT_LEVEL: Record<string, number> = { l1: 0, l2: 1, l3: 2, l4: 3, s1: 0, s2: 1, s3: 2, s4: 3 };

type LogoColor =
    | "panel" | "cyan" | "red" | "green" | "orange" | "white" | "flash"
    | "logo" | "logoStripe"
    | "l1" | "l2" | "l3" | "l4" | "s1" | "s2" | "s3" | "s4";
type LogoPhase = "left" | "top" | "right" | "none";
interface LogoFrame { phase: number; active: LogoPhase; ax: number; ay: number; flash: boolean; white: boolean; }

const LOGO_FRAMES: LogoFrame[] = [
    ...Array.from({ length: 4 }, (_, ay) => ({ phase: 0, active: "left" as const, ax: 2, ay, flash: false, white: false })),
    ...Array.from({ length: 3 }, (_, ay) => ({ phase: 1, active: "top" as const, ax: 2, ay, flash: false, white: false })),
    ...Array.from({ length: 5 }, (_, ay) => ({ phase: 2, active: "right" as const, ax: 5, ay, flash: false, white: false })),
    { phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
    { phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
    { phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
    { phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
    { phase: 4, active: "none", ax: 0, ay: 0, flash: false, white: false },
    { phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
    { phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
    { phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
    { phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
    { phase: 6, active: "none", ax: 0, ay: 0, flash: false, white: false },
];
const LAST_FRAME_INDEX = LOGO_FRAMES.length - 1;

const WHITE_CELLS = new Set(["3,2", "3,3", "3,4", "4,2", "4,4", "5,2", "5,3", "5,5", "6,2", "6,5"]);
const P4_CYAN = new Set(["2,2", "2,3", "2,4", "3,4"]);
const P4_RED = new Set(["3,2", "4,2", "4,3", "5,2"]);
const P4_GREEN = new Set(["4,5", "5,5"]);
const P5_CYAN = new Set(["3,2", "3,3", "3,4", "4,4"]);
const P5_RED = new Set(["4,2", "5,2", "5,3", "6,2"]);
const P5_GREEN = new Set(["5,5", "6,5"]);
const EARLY_ORANGE = new Set(["6,1", "6,2", "6,3", "6,4"]);
const LATE_GREEN = new Set(["4,5", "5,5", "6,5", "6,6"]);
const PIECE_LEFT: [number, number][] = [[0, 0], [1, 0], [1, 1], [2, 0]];
const PIECE_TOP: [number, number][] = [[0, 0], [0, 1], [0, 2], [1, 2]];
const PIECE_RIGHT: [number, number][] = [[0, 0], [1, 0], [2, 0], [2, 1]];

function colorCell(color: LogoColor): string {
    const cg = (n: number) => GMAP[LOGO_COLOR_KEY]?.[n] ?? "34";
    switch (color) {
        case "cyan": return "\x1b[36m██\x1b[39m";
        case "red": return "\x1b[31m██\x1b[39m";
        case "green": return "\x1b[32m██\x1b[39m";
        case "orange":
        case "flash": return "\x1b[33m██\x1b[39m";
        case "white": return "\x1b[39m██";
        case "logo": return `\x1b[${CMAP[LOGO_COLOR_KEY]}m██\x1b[39m`;
        case "logoStripe": return `\x1b[${CMAP[LOGO_COLOR_KEY]}m──\x1b[39m`;
        case "l1": case "l2": case "l3": case "l4":
        case "s1": case "s2": case "s3": case "s4":
            return `\x1b[${cg(GRADIENT_LEVEL[color])}m${color[0] === "l" ? "██" : "──"}\x1b[39m`;
        default: return "  ";
    }
}

function logoCellColor(frame: LogoFrame, y: number, x: number): LogoColor {
    const key = `${y},${x}`;
    if (frame.white) return WHITE_CELLS.has(key) ? "white" : "panel";
    if (frame.flash && y === 6 && x >= 1 && x <= 6) return "flash";
    if (frame.active === "left" && PIECE_LEFT.some(([dy, dx]) => y === frame.ay + dy && x === frame.ax + dx)) return "red";
    if (frame.active === "top" && PIECE_TOP.some(([dy, dx]) => y === frame.ay + dy && x === frame.ax + dx)) return "cyan";
    if (frame.active === "right" && PIECE_RIGHT.some(([dy, dx]) => y === frame.ay + dy && x === frame.ax + dx)) return "green";
    if (frame.phase === 6) {
        const isPi = WHITE_CELLS.has(key);
        const lvl = GRADIENT_ON ? (y <= 3 ? 1 : y === 4 ? 2 : y === 5 ? 3 : 4) : 0;
        if (isPi) return lvl > 0 ? (`l${lvl}` as LogoColor) : "logo";
        return STRIPE_ENABLED && y >= 2 && y <= LOGO_ROWS && x <= 6
            ? lvl > 0 ? (`s${lvl}` as LogoColor) : "logoStripe" : "panel";
    }
    if (frame.phase === 4) {
        if (P4_CYAN.has(key)) return "cyan";
        if (P4_RED.has(key)) return "red";
        if (P4_GREEN.has(key)) return "green";
        return "panel";
    }
    if (frame.phase >= 5) {
        if (P5_CYAN.has(key)) return "cyan";
        if (P5_RED.has(key)) return "red";
        if (P5_GREEN.has(key)) return "green";
        return "panel";
    }
    if (frame.phase <= 3 && EARLY_ORANGE.has(key)) return "orange";
    if (frame.phase >= 2 && P4_CYAN.has(key)) return "cyan";
    if (frame.phase >= 1 && P4_RED.has(key)) return "red";
    if (frame.phase >= 3 && LATE_GREEN.has(key)) return "green";
    return "panel";
}

function piLogoFrame(frameIndex: number): string[] {
    const frame = LOGO_FRAMES[frameIndex];
    const lines: string[] = [];
    for (let y = 1; y <= LOGO_ROWS; y++) {
        let line = "";
        for (let x = 1; x <= LOGO_COLS; x++) line += colorCell(logoCellColor(frame, y, x));
        lines.push(line);
    }
    return lines;
}

const PRECOMPUTED_LOGO_FRAMES: string[][] = LOGO_FRAMES.map((_, i) => piLogoFrame(i));

/* ════════════ Resource enumeration (mirrors pi core discovery) ════════════ */

const AGENTS_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

interface LoadedResources {
    context: string[];
    extensions: string[];
    skillsGlobal: string[];
    skillsPkg: string[];
    skillsLocal: string[];
    prompts: string[];
}

function isRegularFile(path: string): boolean {
    try { return statSync(path).isFile(); } catch { return false; }
}
function isDirectory(path: string): boolean {
    try { return statSync(path).isDirectory(); } catch { return false; }
}
function safeReaddir(path: string): string[] {
    try { return readdirSync(path); } catch { return []; }
}
function safeReadJSON<T = any>(path: string): T | null {
    try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return null; }
}

function displayPath(p: string): string {
    const abs = resolve(p);
    if (HOME && (abs === HOME || abs.startsWith(HOME + sep))) return `~${abs.slice(HOME.length)}`;
    return abs;
}

// ── Context files ──
function collectContextFiles(cwd: string, trusted: boolean): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (p: string) => {
        const a = resolve(p);
        if (!seen.has(a) && isRegularFile(a)) { seen.add(a); out.push(displayPath(a)); }
    };
    const firstIn = (dir: string) => {
        for (const n of AGENTS_CANDIDATES) { const p = join(dir, n); if (isRegularFile(p)) { add(p); return; } }
    };
    add(join(AGENT_DIR, "SYSTEM.md"));
    if (trusted) add(join(cwd, CONFIG_DIR_NAME, "SYSTEM.md"));
    add(join(AGENT_DIR, "APPEND_SYSTEM.md"));
    if (trusted) add(join(cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md"));
    firstIn(AGENT_DIR);
    let dir = resolve(cwd);
    while (true) {
        if (resolve(dir) !== resolve(AGENT_DIR)) firstIn(dir);
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return out;
}

// ── Skills ──
function dirHasSkillMd(dir: string): boolean {
    return isRegularFile(join(dir, "SKILL.md"));
}
function skillName(filePath: string): string {
    const base = basename(filePath);
    return base === "SKILL.md" ? basename(dirname(filePath)) : base.replace(/\.md$/, "");
}
function collectSkillsSub(dir: string): string[] {
    if (dirHasSkillMd(dir)) return [skillName(join(dir, "SKILL.md"))];
    const out: string[] = [];
    for (const name of safeReaddir(dir)) {
        if (name.startsWith(".") || name === "node_modules") continue;
        const f = join(dir, name);
        if (isDirectory(f)) out.push(...collectSkillsSub(f));
    }
    return out;
}
function collectSkillsRoot(dir: string): string[] {
    if (!isDirectory(dir)) return [];
    if (dirHasSkillMd(dir)) return [skillName(join(dir, "SKILL.md"))];
    const out: string[] = [];
    for (const name of safeReaddir(dir)) {
        if (name.startsWith(".") || name === "node_modules") continue;
        const f = join(dir, name);
        if (isDirectory(f)) out.push(...collectSkillsSub(f));
        else if (name.endsWith(".md")) out.push(skillName(f));
    }
    return out;
}

// ── Extensions / prompts ──
function isExtensionFileName(name: string): boolean {
    return name.endsWith(".ts") || name.endsWith(".js");
}
// mirrors resolveExtensionEntries: returns display labels (relative to dir), or null if not an extension.
function collectExtensionEntries(dir: string): string[] | null {
    const manifest = safeReadJSON<any>(join(dir, "package.json"));
    const pi = manifest?.pi;
    if (pi && Array.isArray(pi.extensions) && pi.extensions.length > 0) {
        const labels: string[] = [];
        for (const ext of pi.extensions) {
            const rel = String(ext).replace(/^(\.\.?\/)+/, "").replace(/\/$/, "");
            if (existsSync(resolve(dir, String(ext)))) labels.push(rel || ".");
        }
        if (labels.length > 0) return labels;
    }
    if (isRegularFile(join(dir, "index.ts")) || isRegularFile(join(dir, "index.js"))) return [basename(dir)];
    return null;
}
function collectExtensionsInDir(dir: string): string[] {
    if (!isDirectory(dir)) return [];
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out: string[] = [];
    for (const entry of entries) {
        const p = join(dir, entry.name);
        if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFileName(entry.name)) out.push(entry.name);
        else if (entry.isDirectory() || entry.isSymbolicLink()) {
            const e = collectExtensionEntries(p);
            if (e !== null) out.push(...e);
        }
    }
    return out;
}
function collectPromptFiles(dir: string): string[] {
    if (!isDirectory(dir)) return [];
    return safeReaddir(dir)
        .filter((n) => n.endsWith(".md") && isRegularFile(join(dir, n)))
        .map((n) => `/${n.replace(/\.md$/, "")}`);
}

// ── Packages ──
function resolvePackageDir(entry: string): string {
    if (entry.startsWith("npm:")) return join(NPM_MODULES, entry.slice("npm:".length));
    const stripped = entry.replace(/^git:/, "").replace(/^https?:\/\//, "").replace(/\.git$/, "");
    return join(GIT_ROOT, stripped);
}
function resolvePkgPath(pkgDir: string, rel: string): string {
    let p = join(pkgDir, rel);
    if (!existsSync(p)) p = join(pkgDir, rel.replace(/^(\.\.?\/)+/, ""));
    return p;
}
function collectPackage(pkgDir: string): { extensions: string[]; skills: string[]; prompts: string[] } {
    const manifest = safeReadJSON<any>(join(pkgDir, "package.json"));
    const pi = manifest?.pi;
    const empty = { extensions: [] as string[], skills: [] as string[], prompts: [] as string[] };
    if (!pi || typeof pi !== "object") return empty;
    const pkgName = (typeof manifest.name === "string" && manifest.name) || basename(pkgDir);
    const extensions: string[] = [];
    if (Array.isArray(pi.extensions)) {
        for (const ext of pi.extensions) {
            if (existsSync(resolve(pkgDir, String(ext)))) {
                const rel = String(ext).replace(/^(\.\.?\/)+/, "").replace(/\/$/, "").split("/")[0];
                extensions.push(rel === "index.ts" || rel === "index.js" ? pkgName : `${pkgName}:${rel || "."}`);
            }
        }
    }
    const skills: string[] = [];
    if (Array.isArray(pi.skills)) {
        for (const d of pi.skills) skills.push(...collectSkillsRoot(resolvePkgPath(pkgDir, String(d))));
    }
    const prompts: string[] = [];
    if (Array.isArray(pi.prompts)) {
        for (const d of pi.prompts) prompts.push(...collectPromptFiles(resolvePkgPath(pkgDir, String(d))));
    }
    return { extensions, skills, prompts };
}
function readPackages(): string[] {
    const s = safeReadJSON<{ packages?: unknown }>(SETTINGS_PATH);
    return s && Array.isArray(s.packages) ? s.packages.map(String) : [];
}

function collectResources(ctx: ExtensionContext): LoadedResources {
    const cwd = ctx.cwd;
    const trusted = ctx.isProjectTrusted();

    const extensions = collectExtensionsInDir(join(AGENT_DIR, "extensions"));
    if (trusted) extensions.push(...collectExtensionsInDir(join(cwd, CONFIG_DIR_NAME, "extensions")));

    const prompts = collectPromptFiles(join(AGENT_DIR, "prompts"));
    if (trusted) prompts.push(...collectPromptFiles(join(cwd, CONFIG_DIR_NAME, "prompts")));

    const skillsPkg: string[] = [];
    for (const entry of readPackages()) {
        const dir = resolvePackageDir(entry);
        if (!isDirectory(dir)) continue;
        const c = collectPackage(dir);
        extensions.push(...c.extensions);
        prompts.push(...c.prompts);
        skillsPkg.push(...c.skills);
    }

    return {
        context: collectContextFiles(cwd, trusted),
        extensions,
        skillsGlobal: collectSkillsRoot(join(AGENT_DIR, "skills")),
        skillsPkg,
        skillsLocal: trusted ? collectSkillsRoot(join(cwd, CONFIG_DIR_NAME, "skills")) : [],
        prompts,
    };
}

/* ════════════ Header component ════════════ */

const HINT_COLLAPSED = "Press ctrl+o to show full startup help and loaded resources.";
const HINT_EXPANDED = "Press ctrl+o to collapse.";
const DETAIL_CAP = 50; // max items per section in the expanded view

function formatCwd(cwd: string): string {
    return HOME && cwd.startsWith(HOME) ? `~${cwd.slice(HOME.length)}` : cwd;
}
function padRight(text: string, width: number): string {
    const clipped = truncateToWidth(text, width, "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

class StartupHeader implements Component {
    private frame = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly resources: LoadedResources;
    private expanded = false;
    private cachedInfoRows: Record<number, string> | null = null;
    private cachedInfoWidth = -1;

    constructor(
        private readonly ctx: ExtensionContext,
        private readonly tui: TUI,
        skipAnimation: boolean,
    ) {
        this.resources = collectResources(ctx);
        if (skipAnimation) {
            this.frame = LAST_FRAME_INDEX;
        } else {
            const tick = () => {
                if (this.frame < LAST_FRAME_INDEX) {
                    this.frame++;
                    this.tui.requestRender();
                    this.timer = setTimeout(tick, LOGO_INTERVAL);
                } else {
                    this.timer = null;
                    this.tui.requestRender();
                }
            };
            this.timer = setTimeout(tick, LOGO_INTERVAL);
            this.timer.unref?.();
        }
    }

    setExpanded(expanded: boolean): void {
        if (this.expanded === expanded) return;
        this.expanded = expanded;
        this.cachedInfoRows = null;
        this.tui.requestRender();
    }

    invalidate(): void {
        this.cachedInfoRows = null;
    }

    dispose(): void {
        if (this.timer != null) clearTimeout(this.timer);
    }

    private buildInfoRows(infoMaxWidth: number): Record<number, string> {
        const theme = this.ctx.ui.theme;
        const muted = (s: string) => theme.fg("muted", s);
        const dim = (s: string) => theme.fg("dim", s);

        const r = this.resources;
        const skillsMerged = r.skillsGlobal.length + r.skillsPkg.length;
        const skillsPair = `${skillsMerged}·${r.skillsLocal.length}`;
        const piText = `\x1b[${CMAP[LOGO_COLOR_KEY]}mPi\x1b[39m ${dim(`v${VERSION}`)}`;
        const countsLine = muted(
            [
                `${r.context.length} context`,
                `${skillsPair} skills`,
                `${r.extensions.length} extensions`,
                `${r.prompts.length} prompts`,
            ].join(muted(" | ")),
        );
        const cwdLine = dim(formatCwd(this.ctx.cwd));
        const hintLine = dim(this.expanded ? HINT_EXPANDED : HINT_COLLAPSED);

        const rows: Record<number, string> = { 2: piText, 3: countsLine, 4: cwdLine, 5: hintLine };
        for (const k of Object.keys(rows)) {
            const idx = Number(k);
            rows[idx] = truncateToWidth(rows[idx], infoMaxWidth, "");
        }
        return rows;
    }

    /** Expanded view: detailed loaded-resources breakdown, one item per line. */
    private buildResourceDetail(width: number): string[] {
        const theme = this.ctx.ui.theme;
        const head = (s: string) => theme.fg("mdHeading", s);
        const item = (s: string) => theme.fg("muted", `  ${s}`);
        const r = this.resources;
        const lines: string[] = [];

        lines.push(head(`Context (${r.context.length})`));
        for (const p of r.context.slice(0, DETAIL_CAP)) lines.push(item(p));

        lines.push(head(`Skills (${r.skillsGlobal.length}·${r.skillsPkg.length}·${r.skillsLocal.length})`));
        if (r.skillsGlobal.length) lines.push(item(`global: ${r.skillsGlobal.join(" · ")}`));
        if (r.skillsPkg.length) lines.push(item(`pkg: ${r.skillsPkg.join(" · ")}`));
        if (r.skillsLocal.length) lines.push(item(`local: ${r.skillsLocal.join(" · ")}`));

        lines.push(head(`Extensions (${r.extensions.length})`));
        for (const e of r.extensions.slice(0, DETAIL_CAP)) lines.push(item(e));

        lines.push(head(`Prompts (${r.prompts.length})`));
        for (const p of r.prompts.slice(0, DETAIL_CAP)) lines.push(item(p));

        return lines.map((l) => truncateToWidth(l, width, ""));
    }

    render(width: number): string[] {
        const logoLines = PRECOMPUTED_LOGO_FRAMES[this.frame];
        const logoWidth = LOGO_PIXEL_WIDTH;
        const infoMaxWidth = Math.max(0, width - LOGO_PIXEL_WIDTH);

        let infoRows: Record<number, string>;
        if (this.cachedInfoRows && this.cachedInfoWidth === width) {
            infoRows = this.cachedInfoRows;
        } else {
            infoRows = this.buildInfoRows(infoMaxWidth);
            this.cachedInfoRows = infoRows;
            this.cachedInfoWidth = width;
        }

        const lines: string[] = [];
        for (let i = 1; i < logoLines.length; i++) {
            const right = infoRows[i] != null ? padRight(infoRows[i], infoMaxWidth) : "";
            lines.push(padRight(logoLines[i], logoWidth) + right);
        }
        if (this.expanded) {
            for (const d of this.buildResourceDetail(width)) lines.push(padRight(d, width));
        }
        return lines.map((l) => padRight(truncateToWidth(l, width, ""), width));
    }
}

/* ════════════ Mount + settings ════════════ */

let active: StartupHeader | undefined;
let isResuming = false;

/** Ensure pi's verbose loaded-resources panel stays suppressed. Idempotent. */
function ensureQuietStartup(): void {
    const s = safeReadJSON<any>(SETTINGS_PATH);
    if (!s || typeof s !== "object" || Array.isArray(s)) return;
    if (s.quietStartup === true) return;
    s.quietStartup = true;
    try {
        writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n", "utf-8");
    } catch {
        // non-fatal: panel may still show, but header renders regardless
    }
}

function apply(ctx: ExtensionContext, skipAnimation: boolean): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((tui) => {
        active?.dispose();
        active = new StartupHeader(ctx, tui, skipAnimation);
        return active;
    });
}

export default function (pi: ExtensionAPI) {
    pi.on("session_before_switch", (event) => {
        if (event.reason === "resume") isResuming = true;
    });

    pi.on("session_start", (event, ctx) => {
        ensureQuietStartup();
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

        const skipAnimation =
            event.reason === "reload" ||
            isResuming ||
            (event.reason === "startup" &&
                (process.argv.includes("-r") ||
                    process.argv.includes("--resume") ||
                    process.argv.includes("--session")));
        if (isResuming) isResuming = false;

        setTimeout(() => apply(ctx, skipAnimation), 0);
    });
}
