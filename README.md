# agentboard

A local macOS app for running many Claude Code sessions while talking to only one.
You talk to a **manager** `claude` session; it keeps a task board, briefs and spawns one **worker** `claude`
session per task (own git worktree or workspace folder, meaningful names like `login-tests`), answers the
workers' questions itself, and escalates only irreversible actions and real blockers to you — batched into
one native notification, with a **Needs you** view where you can answer everything in one line
(`12 yes, 13 no, 14 later 2h`). Workers can't notify you. Every session shows live usage from Claude Code itself.

Design: [`SPEC.md`](SPEC.md) (§18 records the review and the verified spike results; §19 the build status).

## Requirements
- macOS 14+ (Apple Silicon), Node ≥ 22.12, git
- Claude Code ≥ 2.1.224, installed and logged in with your Pro/Max account (`claude` once in a normal terminal
  to finish onboarding + login — agentboard can't answer those screens for you)

## Run
```bash
npm install          # node-pty is N-API: no Electron rebuild needed
npm run dev          # electron-vite dev mode
npm test             # unit + integration tests (uses scripts/fake-claude.mjs, no Claude usage)
npm run test:real    # opt-in: launches the real claude CLI without sending a prompt
npm run dist:mac     # signed DMG/zip (needs a Developer ID for notifications + login items)
```
On first launch agentboard creates `~/agentboard/` (override with `AGENTBOARD_HOME`). All worktrees and
workspaces live under it, so trusting it once covers every worker (Claude Code inherits folder trust).

### Configuration (`~/agentboard/`)
| File | Purpose |
|---|---|
| `config.json` | hotkey (default ⌥⌘Space), coalescing window, reminder ladder, usage warn/pause thresholds |
| `repos.json` | `{"repos": {"web": {"path": "/Users/me/src/web", "base_branch": "main", "copy_files": [".env"], "allow_bash": ["pnpm test *"]}}}` |
| `mcp-catalog.json` | MCP servers a task may opt into (`{"gmail": {...}}`), referenced by name in `spawn_worker` |
| `events.jsonl` | the append-only source of truth; `board.md` is generated from it |

## How it works (short)
- **Electron main** owns PTYs (node-pty), the fsync'd event log, a 127.0.0.1 bus (MCP over HTTP + hooks +
  statusLine), the attention scheduler and the only notification code path.
- **Manager ↔ workers** talk with Claude Code's native `SendMessage` (session names = addresses); a
  `PreToolUse` hook keeps workers hub-and-spoke. **App → manager** events arrive through a native
  **channel** (`<channel source="agentboard" …>`), with bracketed-paste as fallback.
- **Permission floor**: a `PreToolUse` hook on every tool blocks irreversible commands (push, merge, deploy,
  deletes outside the workspace, sending, notifier binaries) before allow rules apply; merges/pushes are run
  by the app after your approval, in a temporary worktree so your checkout is never touched.
- **Usage**: each session's statusLine JSON (context %, tokens, list-price cost estimate, 5h/7d plan windows)
  feeds the chips and drawer; hitting the pause threshold stops new spawns.

## Verification status
Verified in CI-like Linux runs: all unit/integration tests; full flow with a fake CLI (spawn → hooks →
permission floor → done → merge escalation → batch answer → merge); Electron UI under Xvfb; and against the
**real Claude Code 2.1.328** without model calls (flags, trust/dev-channel dialogs, MCP-over-HTTP with
header env expansion, channel registration, statusLine feed).
**Not yet verified** (needs macOS and/or real model turns — see SPEC §19): macOS notifications/Dock/tray,
LaunchAgent relaunch, signing; hook payloads that only occur during a turn (`PreToolUse`, `PermissionRequest`,
`Stop`, `Notification`) and `SendMessage` field names with the real CLI; channel text actually reaching the
model on its next turn.
