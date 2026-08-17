# pi-mode

A configurable mode-switcher extension for the [pi](https://pi.dev) coding agent.

Modes bundle a permission policy (flat `allow`/`deny`/`ask`/`classify` format),
enter/exit/per-turn prompts, and an AI bash classifier. Mode state persists per
session and changes are broadcast to other components.

Shipped as a git subtree inside [`@ssparkluo/my-pi`](https://github.com/SsparKluo/my-pi)
(`pi-mode/`). Also usable standalone.

> Status: Layer 4 complete (mode lifecycle + permission + ask + bash cascade + AI classifier).

## Install

### Via my-pi (recommended)

```bash
pi install https://github.com/SsparKluo/my-pi
```

pi-mode is listed in the package manifest and loads with the rest of the collection.

### Standalone / dev

```bash
pnpm install
pi -e ./src/index.ts
```

## Usage

| Surface | Action |
|---------|--------|
| `/mode` | Interactive selector |
| `/mode <name>` | Switch to a named mode |
| `Ctrl+Shift+M` | Cycle modes in config order |
| `--pi-mode <name>` | Start pi already in that mode |

Shipped modes (standalone unless they say `extends`; chains resolve transitively, cycles fail the load):

| Mode | Behavior |
|------|----------|
| **normal** | No prompts. In-workspace tools allowed (except reading `.env`). bash-classify: `READONLY` + `LOCAL_EFFECTS` allow, else ask. |
| **plan** | `extends: normal` + `write`/`edit` denied except `**/*.md`. `internal: true` — reserved for a future `/plan` command. |
| **yolo** | `{}` — no `permission` block at all, so no gating: nothing ever asks. |
| **auto** | `extends: normal`; risky bash (`EXTERNAL_EFFECTS`/`DANGEROUS`/`UNKNOWN`) defers to the small LLM instead of asking; `rm` still asks. |

Omit `permission` for vanilla pi. Modes are config-defined — add your own freely. `extends` gives explicit inheritance: the child deep-merges the parent's `permission` and overlays `classify`/`model` (child keys win); an unknown parent or a cycle makes the whole config fall back to defaults (fail-closed). `internal: true` modes are user-unreachable (`/mode`, selector, cycle, `--pi-mode` all reject/hide them) and exist for programmatic features (e.g. a future `/goal`).

**bash grading.** The `classify` action grades in-process (TS port of
[bash-classify](https://github.com/fprochazka/bash-classify)'s database on top of
unbash; differentially tested against the Python original). Set
`bashClassify.engine: "cli"` to use the external CLI instead (`uv tool install
bash-classify`; `bashClassify.command` overrides). On failure,
`bashClassify.fallback` applies (default `ask`) — never silently allows. Units
mapped to `model` go to the small LLM (`model.model`, retried through
`model.fallbackModels`).

The current mode is always published via `ctx.ui.setStatus("pi-mode", …)` — `◆ <mode>`, colored by category: hands-off modes (`auto`, `full`, `yolo`) red, write-restricted modes (`plan`, `restrict`) yellow, everything else accent — so a custom footer (e.g. my-pi's status extension) can render it. Mode changes also emit `pi-mode:changed` `{ mode, previous, reason }` (`reason` ∈ `startup`/`resume`/`reload`/`switch`).

Inside [herdr](https://herdr.sh), the active mode is reported as the agents-panel
line 2 label (`pi · plan`). A permission ask emits `herdr:blocked` so the pane
shows herdr's **blocked** state until the dialog closes.

Mode state is persisted as a session entry (`pi-mode-state`) and restored on resume, and re-derived on tree navigation (`session_tree`) so an abandoned branch's mode cannot leak into the surviving one.

## Config

Path: **`~/.pi/agent/pi-mode-config.jsonc`**

JSONC (comments + trailing commas). Inside pi's agent dir — respects `PI_AGENT_DIR`
(`join(getAgentDir(), "pi-mode-config.jsonc")`).

If the file is missing, pi-mode **writes** the shipped commented template
(`config/config.example.jsonc`) there on first load. Unreadable files fall back
to the in-memory default (`normal` mode, no permission).

### Schema

```jsonc
{
  "defaultMode": "normal",                             // startup mode if no flag/persisted state; falls back to `normal`, then the first mode
  "commandWrappers": ["rtk","time","nice","command"],   // transparent prefixes stripped before eval
  "modes": {
    "<modeName>": {
      "extends": "<parentName>",        // OPTIONAL — inherit the parent's permission / classify / model
                                      // policy (deep-merged, your keys win); prompts are never inherited
      "onEnterPrompt": "…" | null,   // emitted (label) on the first user message in the mode
      "onExitPrompt":  "…" | null,   // emitted (label) on the next user message after leaving
      "perTurnPrompt": "…" | null,   // emitted (invisible, model-only) before each user message while active
      "permission": {                // OPTIONAL — omit for a prompt-only mode
        "<surface>": "<action>" | { "<pattern>": "<action>", ... }
      },
      "internal": false              // true = user-unreachable: hidden from selector/cycle,
                                     // /mode <name> and --pi-mode reject it (programmatic entry only)
    }
  },
  "bashClassify": {                  // grades units for `classify`
    "command": "bash-classify",
    "byRisk": { "LOW": "allow", "MEDIUM": "ask", "HIGH": "ask" },
    "byClass": { },                  // values: allow | deny | ask | model
    "fallback": "ask",
    "wholeCommandThreshold": 2
  },
  "model": {                         // small LLM for units mapped to "model"
    "model": "anthropic/claude-haiku-4-5",
    "fallbackModels": [],            // tried in order when the primary fails
    "verdicts": ["allow","deny"],    // omit "ask" for a hands-off mode
    "fallback": "deny",
    "cache": true,
    "prompt": null                   // null = built-in default
  },
  "ask": {
    "maxBlockHeight": 10
  }
}
```

- **surfaces**: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `externalPath`,
  `*` (catch-all for unknown/extension tools).
- **actions**: `allow` | `deny` | `ask` | `classify` (grade via bash-classify; `byClass`/`byRisk`
  values are `allow`/`deny`/`ask`/`model` — `model` defers that unit to the small LLM whose
  `verdicts` may exclude `ask` for hands-off modes). Later bash patterns still overwrite.
- **value forms**:
  - string → single action for the whole surface (e.g. `"read": "allow"`).
  - object → pattern→action map, **last-match-wins** (put general rules first,
    specific overrides later). For `bash`/tools, patterns are command-prefix
    globs (`"git push *"`, `"*"`, `"ls"`); for `write`/`edit`/`externalPath`/file reads,
    patterns are **file-path globs** (`"**/*.md"`, `"*"`).

Path globs use minimatch (`dot`, `nocomment`). `**/*.md` matches a top-level
`foo.md`. The pattern `*` is special-cased as match-all. Subjects are resolved
relative to cwd; paths that escape the project match no specific glob
(fail-closed). Modes are config-defined — add your own freely.

### Prompts (not the system prompt)

Prompts are emitted as a separate conversation message
(`customType: "pi-mode-prompt"`, `triggerTurn: false`) during the `input` event —
**never** the system prompt (that would bust the KV-cache prefix every turn),
and never merged into the user's message text. The block precedes the user
message in both the transcript and the model context.

| Transition | What is emitted |
|------------|-----------------|
| Same mode as last message | `perTurnPrompt` (display: false — model-only) |
| Mode change / first message | `onExitPrompt`(prev) then `onEnterPrompt`(curr); shown as a compact label (`plan → auto`) |

`onEnterPrompt` and `perTurnPrompt` are mutually exclusive for a given send.
On session resume and after a tree navigation, `lastSentMode` is seeded to the
restored mode so the first message gets `perTurnPrompt` rather than re-announcing
`onEnterPrompt` (or a stale `plan → …` transition from the abandoned branch).

### Permission gating

Two-phase:

1. `before_agent_start` — globally-denied tools are **hidden** from the model
   (respects `--tools` / `/tools`; late-registered tools re-filtered each turn).
2. `tool_call` — evaluate the surface:
   - file-bearing → match path globs
   - `bash` → unbash cascade (parse → strip transparent wrappers → per-unit
     eval → classifier when `classify`)
   - other tools → pattern match
   - action → allow / deny / ask dialog / classify

Fail-closed everywhere: unknown → ask/deny, never silent allow. Session
approvals (from the ask dialog's "Allow for session") record the matched
pattern as a highest-priority allow for the rest of the session. That option shows the tool plus every target: file calls list paths; bash lists
the unbash units that need approval (those are what get cached). Tags `external`
when a path leaves the project cwd.

### Ask dialog keybinds

| Key | Action |
|-----|--------|
| `↑` `↓` | Move option highlight |
| `Enter` | Confirm highlighted option |
| `y` | Allow once |
| `a` · `s` | Allow for session |
| `Esc` · `n` | Deny |
| `Ctrl+]` | Collapse / expand command body |
| `Ctrl+j` `Ctrl+k` | Scroll command body (expanded & overflowing) |

Non-interactive sessions (`!ctx.hasUI`) deny on `ask` (fail-closed).

### Classifier

Triggered only when a bash unit/surface resolves to `classify` (e.g. auto mode).

- Model: `model.model` (`provider/modelId[:thinkingLevel]`) via `modelRegistry.complete`
- Context: classifier prompt + pi-loaded agents files + previous user / last assistant / current user + whole original command + the uncertain unit(s)
- Verdicts: `model.verdicts` (default `allow`/`deny`); on error/unparseable → `model.fallback` (default `deny`)
- Session cache when `model.cache` is true; `model.fallbackModels` tried in order first
- Flat `deny` rules always win before the classifier runs
- `wholeCommandThreshold` (default 2): if more than this many units need classify, classify the whole command instead

## Architecture

```
src/
  index.ts        # factory; mode state machine; /mode + --pi-mode; prompts; tool hide + tool_call gate
  config.ts       # types + load ~/.pi/agent/pi-mode-config.jsonc + defaults + validation
  jsonc.ts        # comment / trailing-comma strip
  permission.ts   # flat-format evaluation + path-glob + tool-hide helper + session approvals
  bash.ts         # unbash cascade: parse → wrapper-strip → unit eval → classifier dispatch
  classifier.ts   # modelRegistry.complete call, context assembly, cache, fallback
  ask.ts          # custom TUI dialog (ctx.ui.custom)
  status.ts       # footer status text + category color per mode
```

Canonical design decisions, bash cascade details, and open follow-ups: see
[`DESIGN.md`](DESIGN.md).

## Development

```bash
pnpm check   # tsc --noEmit
pnpm test    # vitest run
```

### Pushing subtree changes back upstream

When developing inside a my-pi checkout:

```bash
# from the my-pi repo root
git subtree push --prefix=pi-mode git@github.com:SsparKluo/pi-mode.git master
git subtree pull --prefix=pi-mode git@github.com:SsparKluo/pi-mode.git master
```
