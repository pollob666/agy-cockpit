# Unread (blue dot) regression harness

Runs the real `sidecars/agy-cockpit/ui.html` in headless Chrome, Chromium or Edge and replays the user
flows that broke the blue dot before. No npm packages; the browser is only needed for this test.

```bash
node tests/unread/run.cjs                 # all scenarios
node tests/unread/run.cjs --verbose       # plus snapshots and event logs
node tests/unread/run.cjs --scenario cockpit_switch,native_leave
node tests/unread/run.cjs --ui /path/to/old/ui.html   # reproduce a regression on another version
```

Exit code `0` when every scenario passes, `1` on a failed scenario, `2` when no browser is found
(set `AGY_TEST_BROWSER` or pass `--browser <path>`).

## How it works

- `harness.html` plays the Antigravity host. Like the real aux pane it keeps one Cockpit iframe per
  opened chat, moves the iframes of other chats off-screen without hiding them, stamps the same
  `last_user_view_time` on both chats of every switch, and serves a fake `/api/status` that applies the
  same blue dot rule as `buildConversationCard` in `server.cjs`.
- `shim.js` is injected into a temporary copy of `ui.html` and points `window.sidecar` at that mock.
- `run.cjs` builds the copies in a temp dir, runs each scenario on virtual time (a 25 s flow takes about
  1 to 2 s), reads the result block from the dumped DOM and checks it.

## Scenarios

| Scenario | Flow | Expected |
|---|---|---|
| `cockpit_switch` | In A, click another project and a chat B in the Cockpit while A works; no pointer over the new Cockpit | dots, then blue dot on the antigravity tab; claim stays on B |
| `cockpit_switch_interact` | Same, with an extra Antigravity view stamp on B | same |
| `cockpit_return` | `cockpit_switch`, then antigravity tab and card A inside the Cockpit of B | card A unread, then read for good |
| `stay` | Stay in A until it finishes | no dot, A marked seen |
| `native_leave` | Switch to B from the native sidebar while A works | blue dot |
| `native_enter` | From B, switch to A from the native sidebar and watch it finish | no dot |

The model behind these expectations is documented above `ACTIVE_CONV_STORAGE_KEY` in `ui.html`.
When a live run disagrees with this harness, capture a trace first (see "Unread / Blue Dot Debugging"
in `AGENTS.md`) and teach `harness.html` the host behavior the trace reveals before changing `ui.html`.
