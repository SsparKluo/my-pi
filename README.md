# my-pi

A collection of [pi](https://pi.dev) extensions for an enhanced coding experience.

![Screenshot](https://github.com/user-attachments/assets/e8766ffd-3ff5-474b-a876-3b8f78bfd069)

## Install

```bash
pi install https://github.com/SsparKluo/my-pi
```

Then `/reload`. Update later with `pi update` (or `pi update https://github.com/SsparKluo/my-pi`).

pi clones into `~/.pi/agent/git/github.com/SsparKluo/my-pi` and loads every entry in `package.json` → `pi.extensions`. **Don't edit files inside that clone** — `pi update` runs `git clean -fdx` + `git pull` and will wipe local edits. Personal overrides go in `~/.pi/agent/extensions/`.

<details>
<summary>Legacy manual install / migration</summary>

```bash
pi install https://github.com/SsparKluo/my-pi
# then remove any old copies from ~/.pi/agent/extensions/ and /reload
```

Keeping both the package and manual copies loads the same extensions twice.

</details>

---

## Where to configure what

Every config file is optional. Missing files → built-in defaults (pi-mode writes a commented template on first load).

| What you want to change | File | Scope | Also via |
|-------------------------|------|-------|----------|
| Footer / "Worked for" toggles | `~/.pi/agent/statusline-config.json` | global | `/statusline` |
| Auto-title model | `~/.pi/agent/settings.json` → `"smallModel"` | global | — |
| System prompt | `~/.pi/agent/system-prompt.json` | global | — |
| System prompt (project) | `<project>/.pi/system-prompt.json` | project (trusted only) | — |
| Tool call/result rendering | `~/.pi/agent/tool-display.json` | global only | — |
| Modes / permissions / classifier | `~/.pi/agent/pi-mode-config.jsonc` | global | `/mode`, `--pi-mode` |
| 429 retry on/off & fixed wait | — | session | `/429-retry` |
| Quiet native startup panel | `~/.pi/agent/settings.json` → `"quietStartup"` | global | header `ctrl+o` |

```
~/.pi/agent/                        # pi agent dir (PI_AGENT_DIR)
├── settings.json                   # smallModel, quietStartup, packages, …
├── statusline-config.json          # status toggles
├── system-prompt.json              # system-prompt (global)
├── tool-display.json               # tool-display
├── pi-mode-config.jsonc            # pi-mode
└── requests/                       # request-logger output

<project>/
└── .pi/
    └── system-prompt.json          # system-prompt (project; trusted only)
```

---

## status — footer & "Worked for"

**What it does.** Replaces pi's built-in footer and appends a per-turn "Worked for" line to the conversation stream.

| Zone | Contents |
|------|----------|
| Footer line 1 | Model + thinking, cwd, git, active pi-mode (always shown) |
| Footer line 2 | Magic Context status + cumulative tokens + cache hit rate |
| "Worked for" | Duration, TPS, TTFT, last-request cache rate, per-turn tokens |

### Config: `~/.pi/agent/statusline-config.json`

Written automatically by `/statusline`. All fields default `true`:

```json
{
  "model": true,
  "thinking": true,
  "currentDir": true,
  "gitBranch": true,
  "tokenStats": true,
  "cacheRate": true,
  "tokenUsage": true,
  "tokenSpeed": true,
  "ttft": true
}
```

| Field | Controls |
|-------|----------|
| `model`, `thinking` | Footer line 1 — model + thinking level |
| `currentDir`, `gitBranch` | Footer line 1 — cwd + git branch/dirty counts |
| `tokenStats`, `cacheRate` | Footer line 2 — cumulative tokens + cache hit rate |
| `tokenUsage`, `tokenSpeed`, `ttft` | "Worked for" — per-turn usage / TPS / TTFT |
| `cacheRate` | Also on "Worked for" as last-request cache rate |

### Config: `~/.pi/agent/settings.json` → `smallModel` (auto-title)

After the first completed agent turn, status generates a short session title. Prefer a cheap model:

```json
{
  "smallModel": "anthropic/claude-haiku-4-5"
}
```

Syntax: `provider/modelId[:thinkingLevel]`. Valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Use `:off` to disable reasoning (not `:none`). Falls back to the active session model when absent or unauthenticated.

### Commands

| Command | Effect |
|---------|--------|
| `/statusline` | Interactive toggles (saves to `statusline-config.json`) |
| `/generate-title` | Force-regenerate the session title from the full conversation |

### Cross-extension status keys (read, not configured)

Footer line 1/2 also surface other extensions' `ctx.ui.setStatus` values:

- `pi-mode` — `◆ <mode>`, red for hands-off (`auto`/`full`/`yolo`), yellow for write-restricted (`plan`/`restrict`)
- `magic-context` — usage / state string

---

## tool-display — tool call/result chrome

**What it does.** Overrides rendering for `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `ffgrep`, `fffind`. Adaptive edit diffs, fuller bash expand, muted chrome. Does **not** touch user-message rendering.

### Config: `~/.pi/agent/tool-display.json`

Global only — no project-level file. All keys optional; invalid fields fall back to defaults:

```json
{
  "bashPreviewLines": 5,
  "bashCallPreviewLines": 6,
  "bashRevealCommand": true,
  "diffMode": "auto",
  "diffColumnWidth": 100,
  "diffSyntaxHighlight": false,
  "paddingX": 1,
  "enabled": {
    "read": true,
    "write": true,
    "edit": true,
    "bash": true,
    "grep": true,
    "find": true,
    "ls": true,
    "ffgrep": true,
    "fffind": true
  }
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `bashPreviewLines` | `5` | Tail lines shown for a collapsed bash result |
| `bashCallPreviewLines` | `6` | Max command lines on the call; extras fold as `… (N lines)` |
| `bashRevealCommand` | `true` | On Ctrl+O expand, show the full command above the output |
| `diffMode` | `"auto"` | `"auto"` \| `"single"` \| `"dual"` |
| `diffColumnWidth` | `100` | Width at which `"auto"` switches to side-by-side |
| `diffSyntaxHighlight` | `false` | Highlight diff context via pi's built-in `highlightCode` |
| `paddingX` | `1` | Left padding (spaces) on every tool-block line |
| `enabled.<tool>` | `true` | `false` = keep pi's built-in renderer for that tool |

---

## pi-mode — modes, permissions, bash classifier

**What it does.** Mode-switcher: permission policy + enter/exit/per-turn prompts + optional AI bash classifier. State persists per session.

Out of the box the template ships four **standalone** modes (no inheritance — what you write is what applies): **`normal`** (no prompts, in-workspace tools allowed except reading `.env`, bash via bash-classify), **`plan`** (normal + `write`/`edit` denied except `**/*.md`), **`yolo`** (no `permission` block = no gating, nothing asks), and **`auto`** (risky bash defers to the small LLM instead of asking). Omit `permission` for vanilla pi.

**bash grading.** The `classify` action grades bash commands in-process — a TypeScript port of [bash-classify](https://github.com/fprochazka/bash-classify)'s command database (166 commands, MIT) on top of unbash, differentially tested against the Python original (271-command corpus, 100% match). Set `bashClassify.engine: "cli"` to shell out to the `bash-classify` CLI instead (`uv tool install bash-classify`; `bashClassify.command` overrides the invocation). If grading fails, `bashClassify.fallback` applies (default `ask`) — never silently allows.

### Config: `~/.pi/agent/pi-mode-config.jsonc`

JSONC (comments + trailing commas). Lives in the agent dir (respects `PI_AGENT_DIR`). **Created automatically** on first load if missing, as a commented template you can copy from.

```jsonc
{
  "defaultMode": "normal",
  "modes": {
    // gated baseline
    "normal": {
      "permission": {
        "*": "allow",
        "read": { "*": "allow", "*.env": "ask", "*.env.example": "allow" },
        "externalPath": "ask",
        "bash": "classify"
      }
    },
    // no permission block = no gating at all
    "yolo": {},
    // + plan (write/edit denied except **/*.md) and auto (risky bash → small LLM) — see the template
  },
  "bashClassify": { /* … */ },
  "model": { /* … */ }
}
```

> Modes are standalone — no inheritance. A `permission` block with no matching rule denies (fail-closed), so every gated mode needs a `"*"` baseline.

| Field | Meaning |
|-------|---------|
| `defaultMode` | Startup mode when no flag / no persisted session state (invalid → `normal`, then first mode) |
| `commandWrappers` | Transparent prefixes stripped before bash eval (`time ls` → `ls`) |
| `modes.<name>.onEnterPrompt` | Emitted (compact label) on first message after entering |
| `modes.<name>.onExitPrompt` | Emitted (compact label) on first message after leaving |
| `modes.<name>.perTurnPrompt` | Emitted every turn while in the mode (invisible, model-only) |
| `modes.<name>.permission` | Optional. Omit = prompt-only mode. Surfaces × actions (below) |
| `modes.<name>.classify` | Per-mode overlay on the bashClassify grade maps |
| `modes.<name>.model` | Per-mode overlay on the model classifier (verdicts / fallback) |
| `modes.<name>.internal` | `true` = hidden from selector/cycle, rejects `/mode <name>` and `--pi-mode`; programmatic entry only |
| `bashClassify.command` | CLI invoked per bash unit (stdin → JSON `{classification, risk}`) |
| `bashClassify.byRisk` / `byClass` | Grade maps: verdict per risk/class. Value `model` defers the unit to the small LLM |
| `bashClassify.fallback` | Used when the CLI fails or a verdict maps to nothing (default `ask`) |
| `bashClassify.wholeCommandThreshold` | If more units need grading than this, grade the whole command |
| `model.model` | Small LLM (`provider/modelId` or `provider/modelId:thinkingLevel`) |
| `model.fallbackModels` | Tried in order when the primary model fails / is unauthenticated |
| `model.verdicts` | Allowed LLM answers (default `allow`/`deny`; omit `ask` for hands-off) |
| `model.fallback` | Used on error / unparseable (default `deny`) |
| `model.cache` | Per-session cache of LLM verdicts |
| `model.prompt` | Override classifier system prompt (`null` = built-in) |
| `ask.maxBlockHeight` | Max visible lines of the command body in the ask dialog |

**Permission surfaces:** `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `externalPath`, `*` (catch-all).

**Actions:** `allow` | `deny` | `ask` | `classify` (bash → bash-classify grading; classes mapped to `model` go to the small LLM).

**Value forms:** a string applies to the whole surface (`"read": "allow"`); an object is a pattern→action map, **last-match-wins**. Bash/tool patterns are command-prefix globs (`"git push *"`); write/edit/path patterns are file-path globs (`"**/*.md"`). Modes are config-defined and standalone — add your own freely.

> Prompts are **never** injected into the system prompt (that would bust the KV-cache). They ride as a separate conversation message before the user turn.

Full design (bash cascade, ask keybinds, classifier context): [`pi-mode/README.md`](pi-mode/README.md) · [`pi-mode/DESIGN.md`](pi-mode/DESIGN.md) · template: [`pi-mode/config/config.example.jsonc`](pi-mode/config/config.example.jsonc).

### Runtime controls (not config files)

| Surface | Effect |
|---------|--------|
| `/mode` | Interactive selector |
| `/mode <name>` | Switch to a named mode |
| `Ctrl+Shift+M` | Cycle modes |
| `--pi-mode <name>` | Start pi already in that mode |

---

## system-prompt — managed system prompt

**What it does.** Builds a configurable system prompt while keeping Pi's own resource discovery (AGENTS, skills, tools).

### Config: two files, merged

| Path | When read |
|------|-----------|
| `~/.pi/agent/system-prompt.json` | Always (global) |
| `<cwd>/.pi/system-prompt.json` | Only after Pi trusts the project |

**Merge rules**

- `basePrompt` — project wins if set, else global
- `general` — concatenate (global then project)
- `tools` — merge by name; project entry overrides global entry of the same name
- Neither file exists → extension short-circuits, Pi's prompt untouched

```json
{
  "basePrompt": "You are a focused coding assistant. Follow the user's request and use the available tools when needed.",
  "general": [
    "Be concise in your responses.",
    "Show file paths clearly when working with files."
  ],
  "tools": {
    "read": {
      "snippet": "Read file contents.",
      "guidelines": [
        "Read the relevant files before editing them."
      ]
    },
    "bash": {
      "snippet": "Run shell commands.",
      "guidelines": [
        "Prefer rg for searching files."
      ]
    }
  }
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `basePrompt` | no | Persona / base text. Non-empty → **replace** Pi's whole default prefix with the managed prompt. Empty/absent → only swap the available-tools block (+ inject general). |
| `general` | no | `string[]` → `<general_guidelines>` |
| `tools.<name>.snippet` | yes (per tool) | One-line description in `<tool_use>` (must be non-empty) |
| `tools.<name>.guidelines` | yes (per tool) | `string[]` of per-tool preferences (may be empty `[]`) |

**Guideline principle.** Tool schema `description` fields are always sent via the API `tools` param regardless of the system prompt. Put only what the schema does **not** say in `guidelines` (preferences, workflows, discipline) — restating schema text wastes tokens.

### What gets assembled (when `basePrompt` is set)

```text
{basePrompt}

<general_guidelines>
- …
</general_guidelines>

<tool_use>
- read: …
  - …
</tool_use>

<env>
  Working directory: …
  Workspace root folder: …
  Is directory a git repo: yes|no
  Platform: …
</env>

<global_instruction>…</global_instruction>     ← AGENTS/CLAUDE under agent dir
<project_instruction>…</project_instruction>     ← AGENTS/CLAUDE under project
<available_skills>…</available_skills>           ← Pi's skill formatter (if read is enabled)
```

Only tools currently enabled by Pi appear under `<tool_use>`; an unconfigured enabled tool falls back to Pi's own one-line snippet. Context files and skills are never rediscovered by this extension — they follow Pi's loader and flags.

When `basePrompt` is absent, the extension only replaces Pi's "Available tools:" block with `<tool_use>`, injects `<general_guidelines>` if configured, and strips Pi's default `Guidelines:` section. The rest of Pi's prompt is preserved.

---

## 429-retry — auto-retry rate limits

**What it does.** Retries transient HTTP 429s (any provider): up to 10 attempts, live status-bar countdown. Uses the response `retry-after` when present; otherwise an increasing wait sequence (`5, 10, 20, 30, 60, 90, …` — +30s after 30). Hard usage limits fail fast with the reset time.

### Config: none (runtime only)

| Command | Effect |
|---------|--------|
| `/429-retry` | Toggle on/off |
| `/429-retry <seconds>` | Use a fixed wait (seconds) instead of the increasing sequence |}

---

## startup-header — boot screen

**What it does.** Animated pixel Pi logo + compact resource counts. `ctrl+o` expands the detailed loaded-resources breakdown.

### Config: `~/.pi/agent/settings.json` → `quietStartup`

Expanding the header sets `"quietStartup": true` so Pi's verbose native loaded-resources panel stays hidden. Restore it with:

```json
{
  "quietStartup": false
}
```

No other config file.

---

## Extensions with no config

| Extension | What it does | Notes |
|-----------|--------------|-------|
| **editor** | Mode-colored input border; `$skill` mentions + picker | No config file |
| **request-logger** | Logs every provider request to `~/.pi/agent/requests/<session>.request.log` | Output dir only; no knobs |
| **shortcuts** | `Ctrl+Shift+C` → copy editor content to clipboard | No config file |

---

## Package layout (for contributors)

```
editor.ts
request-logger.ts
shortcuts.ts
429-retry.ts
startup-header.ts
system-prompt.ts          # + system-prompt-{config,core,env}.ts
status/                   # footer, worked-for, auto-title, /statusline
tool-display/             # render overrides + ~/.pi/agent/tool-display.json
pi-mode/                  # vendored subtree → ~/.pi/agent/pi-mode-config.jsonc
```

Loaded-resources labels use the package.json `name`: `@ssparkluo/my-pi:editor.ts`, `@ssparkluo/my-pi:status`, …
