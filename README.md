# Antigravity Context Health (`context-health`)

Cross-platform **Antigravity Sidecar UI Pane** and **PreInvocation Warning Hook** for **Windows** and **Linux** (pure Node.js, zero external dependencies).

Monitors conversation context pollution caused by successive context compactions (`CHECKPOINT` events) and repository Git drift (`commits behind HEAD`), and provides one-click context handoffs into fresh conversations.

---

## Features

### 1. Real-Time Context Pollution & Prompt Retention
- **No internal step numbers**: Tracks conversations strictly in terms of **Compacts** (`"type":"CHECKPOINT"`) and **User Prompts** (`"type":"USER_INPUT"`).
- **Compaction Scale**:
  - `0 to 2 compacts` (with `0` compacted prompts): **Fresh** (`#10b981`)
  - `3 to 5 compacts` (or `0 to 2` compacts once earlier prompts are compacted): **Warm** (`#eab308`)
  - `6 to 9 compacts`: **Heavy** (`#f97316`)
  - `10+ compacts`: **Polluted** (`#ef4444`)
- **Prompt Retention Metric**: Each Antigravity compaction retains only the last 10 user requests in full. When `compacts >= 1` and `prompts > 10`, the active card displays `Prompts: 10 full · M compacted`.
- **Dynamic Compact Threshold (Zero Hardcoded Limits)**:
  - Reads `currentTokens = input_tokens + cache_read_tokens` from the latest `PLANNER_RESPONSE`.
  - Records `compactTriggerTokens` immediately preceding each `CHECKPOINT` and computes `observedCompactCeiling` as their rolling median.
  - Adapts automatically if Antigravity changes the context window size in future updates. If `currentTokens` exceeds a previously observed ceiling before a new compact triggers, the stale percentage is hidden until the new compact point is observed.

### 2. Git / Repository Drift Detection
- Detects the dominant Git repository root associated with each conversation and compares the conversation's last turn timestamp against `HEAD` (excluding commits created inside that conversation).
- Displays `HEAD in sync` or `N commits behind HEAD` alongside the list of missed commit hashes and subjects.

### 3. Main Chats vs Subagents Separation
- Automatically identifies subagent conversations (via `invoke_subagent` tool calls or initial `<SYSTEM_MESSAGE>` with `sender=<uuid>`) and excludes them from the main conversation list so only top-level user conversations are shown.

### 4. Project-Scoped Filtering, Search & Expandable Details
- **Pinned Active Chat Card**: Automatically pins the active conversation of the current window's workspace at the top with a live context meter bar.
- **Workspace-Aware Scope**: Scopes the conversation list and search bar to the active project workspace (`window.sidecar.getWorkspaceUris()` / `onWorkspaceChange`), with filter tabs to switch across projects or `All`.
- **Real-Time Search**: Searches across all `USER_INPUT` prompts and `Task Overview` checkpoint summaries.
- **Clamped Prompt History**: Expanding `History & Commits` lists missed Git commits, the latest compact overview, and user prompts clamped to 3 lines (`Show more` / `Show less`).

### 5. Two-Step Smart Handoff
- **Step 1 (Optional Focus & AI Generation)**: Opens a large editable textarea where you can optionally specify focus instructions, then sends a `<HANDOFF_PROMPT>` request to the conversation's main agent via `window.sidecar.agent.sendMessage(...)`.
- **Step 2 (In-Place Review, Edit & Launch)**: Once the agent generates the `<HANDOFF_PROMPT>` block, it is loaded directly into the same textarea in the plugin so you can review and edit it in place before clicking **Start New Chat** (`window.sidecar.agent.startConversation(...)`) or **Copy**.

### 6. Lightweight `PreInvocation` Hook (`< 20 ms`)
- Runs before each user turn via `~/.gemini/config/hooks.json`.
- Stays completely silent (`{}`) when `compacts < 10` and `commitsBehind === 0`.
- When `compacts >= 10` (**Polluted**) or `commitsBehind >= 1`, outputs a transient `injectSteps: [{ ephemeralMessage: ... }]` instruction so the agent prepends a one-line status banner (`⚠️ [Context Health: ...]`) without polluting `transcript.jsonl`.

---

## Performance Architecture

1. **Incremental Append-Only Transcript Indexing**:
   - `server.cjs` caches `mtimeMs`, `size`, and `parsedBytes` per conversation in memory and persists `index_cache.json`.
   - On subsequent polls, only newly appended bytes (`stat.size - parsedBytes`) are read from disk, and `"type":"GENERIC"` lines are skipped before `JSON.parse` once the workspace root is known (`< 1 ms` per status poll).
2. **Zero-Process Git Reflog Tail Parser + `.git/HEAD` Mtime Guard**:
   - Both the hook and server inspect `.git/HEAD` and `.git/logs/HEAD` `mtimeMs` first (`0.2 ms`, zero child processes spawned in the `PreInvocation` hook).

---

## Installation (Windows & Linux)

Requires **Node.js 18+**. Works out of the box on both **Windows** and **Linux**:

```bash
node setup.cjs
```

Verify installation status:

```bash
node setup.cjs --check
```

Uninstall from `~/.gemini/config`:

```bash
node setup.cjs --uninstall
```

### Opening the Sidecar Panel in Antigravity
Once installed, `Context Health` is automatically enabled and available in the right **Auxiliary Pane** (`Extensions` tab), the left **Sidebar** (`Plugins` section), or by clicking the sidecar link in any Antigravity chat response:
- `[Context Health](sidecar://context-health/context-health/ui.html)`

---

## Repository Structure

```text
.
├── plugin.json                       # Antigravity plugin manifest (auto-enables sidecar)
├── sidecars/
│   └── context-health/
│       ├── sidecar.json              # Antigravity sidecar manifest (AUX_PANE + SIDEBAR)
│       ├── server.cjs                # HTTP + incremental transcript & git indexing server
│       └── ui.html                   # Auxiliary pane UI
├── hooks/
│   └── context-health-check.cjs      # Sub-20ms PreInvocation warning hook
├── setup.cjs                         # Cross-platform installer (Windows & Linux)
├── AGENTS.md                         # Instructions for AI coding agents
└── README.md
```
