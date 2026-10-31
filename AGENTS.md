# AGENTS.md

Instructions and architectural guidelines for AI coding agents working in this repository.

## Project Overview

This repository contains **Context Health** (`context-health`), a custom Antigravity Plugin and Sidecar UI Pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE` and `SIDECAR_UI_ENTRYPOINT_SIDEBAR`) with a `PreInvocation` hook for Windows and Linux.

- **Plugin manifest**: [`plugin.json`](./plugin.json)
- **Sidecar source**: [`sidecars/context-health/`](./sidecars/context-health) (`sidecar.json`, `server.cjs`, `ui.html`)
- **PreInvocation hook source**: [`hooks/context-health-check.cjs`](./hooks/context-health-check.cjs)
- **Cross-platform installer**: [`setup.cjs`](./setup.cjs)

## Opening the Sidecar in Chat

Whenever you install, update, or reference the Context Health sidecar in a response to the user, include the clickable sidecar pill link:

[Context Health](sidecar://context-health/context-health/ui.html)

## Core Invariants & Engineering Rules

1. **Zero External Dependencies**:
   - Keep `server.cjs`, `context-health-check.cjs`, and `setup.cjs` in pure Node.js (`node:fs`, `node:path`, `node:os`, `node:http`, `node:child_process`, `node:url`) with zero npm packages.
2. **Cross-Platform Compatibility (Windows & Linux)**:
   - Never hardcode Windows drive letters (`C:/...`, `d:/...`) or platform-specific path separators.
   - Always resolve `~/.gemini/antigravity` (and fallback candidates `antigravity-ide`, `antigravity-cli`) dynamically via `os.homedir()` and `process.env.ANTIGRAVITY_APP_DATA_DIR`.
   - Normalize `file://` URIs and filesystem paths via `normalizeWorkspacePath()`.
3. **Plugin Packaging & Hook Placement**:
   - Install `context-health` as a plugin under `~/.gemini/config/plugins/context-health/` (`plugin.json` + `sidecars/context-health/`) so Antigravity auto-enables and auto-starts the sidecar by default (standalone sidecars in `~/.gemini/config/sidecars/` default to `SIDECAR_STATUS_STOPPED`).
   - Antigravity enforces a system protection boundary on `~/.gemini/config/hooks/*`. Always install the executable hook script inside `~/.gemini/config/plugins/context-health/sidecars/context-health/context-health-check.cjs` and reference `./plugins/context-health/sidecars/context-health/context-health-check.cjs` from `~/.gemini/config/hooks.json`.
   - For `PreInvocation`, output `{"injectSteps": [{"ephemeralMessage": "..."}]}` on `stdout` (or `{}` when healthy). Never inject persistent steps that bloat `transcript.jsonl`.
4. **Performance Budgets**:
   - `hooks/context-health-check.cjs` must execute in `< 20 ms` with **zero child process spawns** (use buffer scanning on `transcript.jsonl` and tail parsing on `.git/logs/HEAD`).
   - `server.cjs` `/api/status` refreshes must stay `< 5 ms` on warm cache using byte-offset incremental parsing (`parsedBytes`) and `.git/HEAD` `mtimeMs` caching.
5. **User-Facing Terminology & Compaction Tiers**:
   - Never expose raw `step_index` numbers in `ui.html`. Display **Compacts** (`CHECKPOINT` count) and **Prompts** (`USER_INPUT` count).
   - Never hardcode a fixed token limit for the compaction progress bar; always compute `observedCompactCeiling` dynamically as the median of `compactTriggerTokens`.
   - Compaction health tiers: **Fresh** (`0-2` compacts with `0` compacted prompts), **Warm** (`3-5` compacts, or `0-2` compacts once earlier prompts are compacted), **Heavy** (`6-9` compacts), **Polluted** (`10+` compacts, where `PreInvocation` warnings also trigger).
