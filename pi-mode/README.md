# pi-mode

A configurable mode-switcher extension for the [pi](https://pi.dev) coding agent.

Modes bundle a permission policy (flat `allow`/`deny`/`ask`/`classify` format),
enter/exit/per-turn prompts, and an AI bash classifier. Mode state persists per
session and changes are broadcast to other components.

> Status: Layer 4 complete (mode lifecycle + permission + ask + bash cascade + AI classifier).

## Install (dev)

```bash
pnpm install
pi -e ./src/index.ts
```

## Config

`~/.pi/pi-mode/config.json` — see `config/config.example.json` for the full
default (plan / normal / auto).

## Development

```bash
pnpm check   # tsc --noEmit
pnpm test    # vitest run
```
