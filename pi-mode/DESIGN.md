# pi-mode — Design

Canonical spec for requirements and design. Implementation proceeds layer by
layer (see Architecture). All decisions below were settled in the design
(grilling) session; later, amend this file when the design changes.

## 1. Requirements

A pi coding-agent extension implementing a **mode-switcher**. A *mode* bundles a
permission policy, prompts injected on enter/exit/per-turn, and (optionally) an
AI bash classifier.

- Modes are **config-defined** (arbitrary set, not a hardcoded enum).
  Ship a single **`default`** mode in the written template: no prompts, in-workspace
  tools allowed (except reading `.env`), bash via bash-classify (`READONLY` +
  `LOCAL_EFFECTS` allow, else ask). Omit `permission` for vanilla pi.
- **Everything configurable**: permission rules, prompts, classifier model,
  command wrappers, thresholds.
- Config file: **`~/.pi/agent/pi-mode-config.jsonc`** (JSONC, inside the agent
  dir; respects `PI_AGENT_DIR`). Missing → write `config/config.example.jsonc`.
- **Mode state persists per session** and is restored on resume (so exit/enter
  prompts re-inject correctly and the mode survives restarts).
- **Notify other components on mode change** (and at startup) so UI components
  can render based on the mode.
- **Permission control is optional per mode** — a mode may do prompt-injection
  only (omit the `permission` block). `default` without `permission` is vanilla
  pi. Other modes inherit `default`'s rules (or all-allow if it has none), then
  overwrite listed surfaces / patterns.
- **Bash is parsed via `unbash` (AST)** before any AI classification.
- Standalone (no third-party permission package); adopt the flat permission
  *format* from `@gotgenes/pi-permission-system`.
- **Fail-closed everywhere**: unknown → ask/deny, never silent allow.

## 2. Key design decisions

| Ref | Decision |
|---|---|
| Q1 | Config-defined arbitrary modes; shipped default is `default` (no gating). plan/auto are template comments. |
| Q2 | Standalone; flat permission format (`allow`/`deny`/`ask`/`classify`, last-match-wins). |
| Q3 | `permission` block optional (omit → prompt-only). `classify` is a first-class action. Global `commandWrappers`. |
| Q4 | Three optional prompt fields emitted as their own block at send time (never the system prompt — that would bust the KV-cache prefix): `onEnterPrompt`/`onExitPrompt` on a mode change (displayed as a compact label), `perTurnPrompt` while staying in a mode (invisible, model-only). State persisted via session entry. |
| Q5 | Broadcast `pi-mode:changed` event + footer status line + session-entry-readable. UX: `--pi-mode` flag, `/mode` command + selector, cycle shortcut. No service accessor yet. |
| Q6 | `classify` grades via bash-classify (`byClass`/`byRisk` → allow/ask/deny/`model`); `model` defers the unit to the small LLM (`model.verdicts` may exclude `ask`). Explicit bash patterns still win (last-match-wins). |
| Q7 | Ask dialog = custom TUI (`ctx.ui.custom`); codeblock, foldable, max-height internal scroll; session approvals record the matched pattern; fail-closed non-interactive deny. |
| §38 | `unbash` parses bash to AST before classification. |
| §47 | Transparent wrappers (`rtk`, …) stripped; hiding wrappers (`eval`, `sudo`, …) → fail-closed ask. |
| §60 | Classifier context = whole original command + pi-loaded agents files + previous user / last assistant / current user. |
| §61/63 | Cascade: unbash units for deterministic verdicts; classify ≤threshold uncertain units (whole command as context); else (>threshold or unbash fails) classify whole command. |

## 3. Configuration schema

See `config/config.example.jsonc` for the shipped (commented) template.

```jsonc
{
  "defaultMode": "default",                             // startup mode if no flag/persisted state
  "commandWrappers": ["rtk","time","nice","command"],   // transparent prefixes stripped before eval
  "modes": {
    "<modeName>": {
      "onEnterPrompt": "…" | null,   // emitted (label) on the first user message in the mode
      "onExitPrompt":  "…" | null,   // emitted (label) on the next user message after leaving
      "perTurnPrompt": "…" | null,   // emitted (invisible, model-only) before each user message while active
      "permission": {                // OPTIONAL — omit for a prompt-only mode
        "<surface>": "<action>" | { "<pattern>": "<action>", ... }
      }
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
- **actions**: `allow` | `deny` | `ask` | `classify`.
- **value forms**:
  - string → single action for the whole surface (e.g. `"read": "allow"`).
  - object → pattern→action map, **last-match-wins** (put general rules first,
    specific overrides later). For `bash`/tools, patterns are command-prefix
    globs (`"git push *"`, `"*"`, `"ls"`); for `write`/`edit`/`externalPath`/file reads,
    patterns are **file-path globs** (`"**/*.md"`, `"*"`).

> Path globs use minimatch (`dot`, `nocomment`). `**/*.md` matches a top-level
> `foo.md` (globstar may be empty). The pattern `*` is special-cased as match-all
> (minimatch's `*` does not cross `/`). Subjects are resolved relative to cwd;
> paths that escape the project (`..`, absolute outside cwd) match no specific
> glob (fail-closed). Bash/tool patterns are command-prefix globs where `*`
> matches any characters including spaces and slashes.

## 4. Architecture

```
src/
  index.ts        # factory; mode state machine; /mode + --pi-mode; prompts; tool hide + tool_call gate
  herdr.ts        # herdr agents-panel label + herdr:blocked around the ask dialog
  config.ts       # types + load ~/.pi/agent/pi-mode-config.jsonc + defaults + validation
  jsonc.ts        # comment / trailing-comma strip
  permission.ts   # flat-format evaluation + path-glob + tool-hide helper + session approvals
  bash.ts         # unbash cascade: parse → wrapper-strip → unit eval → classifier dispatch
  classifier.ts   # modelRegistry.complete call, context assembly, cache, fallback
  ask.ts          # custom TUI dialog (ctx.ui.custom)
```

Layers (each an independently runnable/verifiable slice):
0. Scaffold (done).
1. Mode lifecycle (prompt-only modes end-to-end).
2. Permission gating + ask dialog.
3. Bash pipeline (unbash cascade, allowlist).
4. AI classifier (done).

## 5. Mode lifecycle

**State.** Current mode stored as a **session entry**
`pi.appendEntry("pi-mode-state", { mode, ts })`. Restored on `session_start`
(reason `startup`/`resume`/`reload`) via `ctx.sessionManager.getBranch()` — the
leaf→root walk, so a rewind restores the surviving branch's mode, not the file
tail's; falls back to `defaultMode` then `default`.

**Switching** (`--pi-mode <name>` flag, `/mode` selector, `/mode <name>`, cycle shortcut)
only changes mode state — it emits no prompt. The mode's prompt attaches to the
user's next message at send time (see Prompts below):
1. Update current mode; persist session entry.
2. Emit `pi-mode:changed` `{ mode, previous, reason: "switch" }`.
3. Update footer status line.

**Prompts** are emitted as a separate block via `sendMessage`
(`customType: "pi-mode-prompt"`, `triggerTurn: false`) during the `input` event
— never the system prompt, and never merged into the user's message text.
Appending to the system prompt would invalidate its KV-cache prefix every turn.
The block is appended before the user message is committed, so it precedes it
in both the transcript and the model context. Which prompt(s) the block carries
depends on the mode transition since the last sent message:
- same mode as last message → `perTurnPrompt` (every message while active);
- mode change (or first message) → `onExitPrompt`(prev) then `onEnterPrompt`(curr);
- `onEnterPrompt` and `perTurnPrompt` are mutually exclusive.

**Display.** A custom `MessageRenderer` keeps the transcript quiet:
- `perTurnPrompt` blocks are `display: false` — they reach the model (custom
  messages become user-role messages in `convertToLlm` regardless of `display`)
  but render nothing;
- transition blocks are `display: true` and render only a compact label
  (`⏸ entered plan` / `⏸ left plan`), never the raw prompt text.
On `session_start` resume, `lastSentMode` is seeded to the restored mode so the
first message gets `perTurnPrompt` rather than re-announcing `onEnterPrompt`.

**Notification.** `pi.events.emit("pi-mode:changed", { mode, previous, reason })`
on every switch and on `session_start` after restore
(`reason` ∈ `startup`/`resume`/`reload`/`switch`); footer status line via
`ctx.ui.setStatus("pi-mode", …)`. Startup emits so UI renders the initial mode.

## 6. Permission model

Flat format (surfaces × actions, last-match-wins), evaluated in `permission.ts`.
Two-phase gating:
1. `before_agent_start` — globally-denied tools are **hidden** from the model.
   Candidates are the current active set plus tools we hid earlier — never the
   full catalog, so `--tools` / `/tools` stays intact. Late-registered tools
   that land in the active set are re-filtered each turn.
2. `tool_call` — gate the call:
   - resolve the surface (read/write/edit/grep/find/ls/bash/tool).
   - file-bearing surfaces → match the **path** against path globs (plan's
     `*.md`-allowlist).
   - `bash` → delegate to the bash cascade (§7).
   - tools → match against tool patterns.
   - action → allow (pass) / deny (`{block:true, reason}`) / ask (§9) /
     classify (bash → §7/§8).

Plan's path rule `{ "*": "deny", "**/*.md": "allow" }` (deny general first,
specific allow last under last-match-wins) = only markdown writable.

## 7. Bash pipeline (cascade)

Resolving a bash `tool_call`:
1. `unbash.parse(wholeCommand)`.
2. **unbash fails** → whole-command path (step 5), raw string; if that is not
   already `deny`, fail-closed to `ask` (broken syntax must not silently allow).
3. **unbash succeeds** → decompose into command units; recursively strip
   transparent wrappers (`commandWrappers`); evaluate each unit against the
   mode's `bash` rules → per-unit action.
   - any `deny` → **deny** (done).
   - any `ask` → **ask human** (whole command shown; approval records the matched ask pattern).
   - collect `classify` units:
     - 0 → merge remaining → done.
     - ≤ `wholeCommandThreshold` (default 2) → classify those units (§8),
       whole command as context.
     - > threshold → whole-command path (step 5).
4. **Whole-command path** (unbash failed or too many uncertain): evaluate whole
   raw string against `bash` rules → allow/deny/ask directly; `classify` → send
   whole command to classifier.
5. **Classifier** resolves any `classify` (§8).
6. **Merge** all now-concrete verdicts, most-restrictive-wins (`deny > ask > allow`).

**Wrappers.**
- **Transparent** (`commandWrappers`, default `rtk,time,nice,command`): stripped
  recursively before eval (`time nice rtk ls` → `ls`).
- **Hiding/indirection** (`eval`, `bash -c`, `sudo`, `xargs`, `find -exec`,
  `$()`, backticks): opaque units → **fail-closed `ask`**. Catastrophic denies
  (`rm -rf /` etc.) stay denied by flat rules before any of this.

## 8. AI classifier

Triggered only when a bash unit/surface resolves to `classify`.
- **Model call**: `ctx.modelRegistry.find(provider, model)`; guard
  `hasConfiguredAuth`; `complete({messages}, { reasoningEffort:"low",
  cacheRetention:"none", sessionId: fresh })`. Read text content.
- **Context**:
  - system: classifier instructions (built-in default or `model.prompt`).
  - Agents files (whatever pi put in `systemPromptOptions.contextFiles`, cached at `before_agent_start`).
  - last 3 **user** messages (`ctx.sessionManager.getBranch()` filtered).
  - the **whole original command** (context).
  - request: the **uncertain unit(s)** (≤threshold case) OR the whole command
    (whole-command case).
- **Verdict**: parse response to `model.verdicts` (`allow`/`deny`);
  tie-break toward `deny`. On error/unparseable → `model.fallback`
  (default `deny`).
- **Cache**: `model.cache` → per-session `Map` keyed by normalized
  unit/command string; repeats short-circuit.
- **Safety floor**: flat `deny` rules always win (evaluated before classifier).

## 9. Ask dialog

When `ask` is reached (any surface):
- Non-interactive (`!ctx.hasUI`) → **deny** (fail-closed).
- Custom TUI via `ctx.ui.custom((tui, theme, kb, done) => ({ render, invalidate, handleInput }))`.
- Layout: header (surface + e.g. "bash"); **command body** (no box border —
  distinct bg/fg; max height `ask.maxBlockHeight` default 10; overflow →
  internal scroll with `n/total` indicator; collapsible); 3 options — Allow
  once / Allow for session (shows tool + targets; bash lists the unbash ask units and caches those unit texts; file calls show paths and still cache the matched pattern; marks `external` when a path leaves cwd) / Deny. `↑`/`↓` move the
  option highlight; `Enter` confirms the highlighted option.
- **Keybinds** (fixed in `ask.ts` for v1; configurable is a follow-up):

  | Key | Action |
  |---|---|
  | `↑` `↓` | Move option highlight |
  | `Enter` | Confirm highlighted option |
  | `y` | Allow once |
  | `a` · `s` | Allow for session |
  | `Esc` · `n` | Deny |
  | `Ctrl+]` | Collapse / expand command body |
  | `Ctrl+j` `Ctrl+k` | Scroll command body (expanded & overflowing) |

- **Session approvals**: recorded as highest-priority rules (matched pattern →
  allow for the session). v1 records the exact matched pattern; smarter pattern
  generalization is a follow-up.

## 10. Open / follow-ups

- Configurable ask keybinds.
- Smarter session-approval pattern suggestion (arg wildcards, path prefixes).
- Adaptive `maxBlockHeight` to terminal height.
- Optional `Symbol.for()` service accessor if a consumer needs live synchronous queries.
- Relax the `unbash` version pin once aged past `minimumReleaseAge`.
