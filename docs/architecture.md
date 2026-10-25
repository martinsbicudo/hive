# Architecture

```
┌──────────────── Hive.app (Swift, menu-bar accessory) ────────────────┐
│ NotchController ── one NotchPanel per screen (SwiftUI)               │
│ HubClient ── WebSocket /ws + REST ───────────┐                       │
│ Board window (WKWebView) ── loads the board ─┤                       │
│ Daemon ── spawns node if nothing listens ────┤                       │
└──────────────────────────────────────────────┼───────────────────────┘
                                               ▼
┌──────────── hive daemon (Node 24, 127.0.0.1:47321) ──────────────────┐
│ server.ts   HTTP + WebSocket, token + origin checks, serves the board│
│ hub.ts      agents, chats, approvals, usage, broadcasts state        │
│ runner.ts   one claude / codex process per turn, queue per agent     │
│ db.ts       SQLite (node:sqlite) at ~/.hive/hive.db                  │
│ mcp/hive-mcp.ts  MCP server "hive" exposing the `approve` tool       │
└──────────────────────────────────────────────────────────────────────┘
          │ spawn per message                       ▲ approve(tool, input)
          ▼                                         │ (long-poll)
   claude -p … --permission-prompt-tool mcp__hive__approve
   codex exec --json … (sandbox workspace-write)
```

## Pieces

| Folder | What | Tech |
|---|---|---|
| `notch/` | The macOS app: notch panels, menu bar item, board window, daemon launcher | Swift 6.2 package, SwiftUI + AppKit, no Xcode project |
| `daemon/` | The orchestrator. Owns all state and runs the engines | Node 24 running `.ts` directly (type stripping), `node:sqlite`, `ws`, MCP SDK, DiceBear + resvg |
| `web/` | The board: agents, chat, usage | React 19 + Vite, imports types from `daemon/src/types.ts` |
| `scripts/` | Build, sign, install | bash |
| `brand/` | Logo concepts and the brand kit (`kit/`: SVG masters, exports, guidelines) | SVG, Python (shapely) |

`Hive.app/Contents/Resources` bundles `daemon/src` with its production `node_modules` plus `web/dist`. Node itself
is not bundled; the app looks in `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`.

## Lifecycle

1. The app starts and calls `GET /health?nonce=…`. If a daemon already answers with a proof that matches
   `~/.hive/token` (e.g. `make dev`), it uses that one. If something answers without a valid proof, the app retries
   for about 10 s (a previous app's daemon exits within 5 s), then shows "Port 47321 is used by another program".
   The secret is only used after a proof for a fresh nonce matched it (see
   [daemon-api.md](daemon-api.md#public)).
2. Otherwise it spawns `node Resources/daemon/src/main.ts` with `HIVE_PORT`, `HIVE_WEB_DIR`, `HIVE_PARENT_PID`
   and `HIVE_SECRET_STDIN=1`, and writes a fresh random UI secret to its stdin. Output goes to `~/.hive/daemon.out`.
   If the daemon on the port then answers with a wrong proof, the app stops its child and shows the same message.
3. The daemon checks every 5 s that the parent is alive and stops if not, so a crashed app never leaves it behind.
   Quitting the app (menu, `osascript`, SIGTERM) stops it right away.
4. On shutdown the daemon marks the Hub as closing, stops schedules and running engines, drains active and preparing
   runs, then stops its loaded computer resources. It closes SQLite only after that cleanup. Runs left in the database
   from an unclean exit are marked failed on the next start (`failInterruptedRuns`).

## Computer resources

`agents.computer_id` is the assignment source. Agent IDs remain the identity for chats, sessions, tasks, budgets,
approvals and trust; the `computer: mac | virtual` field remains a compatibility view derived from that assignment.
Each computer resource has its own stable ID, name, runtime, profile, revision and managed/private flag. A new
virtual agent receives a private Docker desktop resource whose ID is initially its agent ID. Legacy virtual agents
are migrated to the same ID so existing container names and home volumes can be adopted.

A private computer can be promoted to managed in place, preserving its disk, then attached to other virtual agents.
Members share the computer's files, browser state, processes and screen. Their chats and task histories remain
separate. The board discloses this before sharing or attaching. Runs on one resource take a whole-turn lease, so
members' writes are serialized; reassignment and profile changes invalidate old run contexts and approval grants.
The run token captures the computer ID, revision, runtime, profile and lease ID. Every internal computer call checks
the token's agent and current resource lease rather than taking resource identity from request JSON.
Each lease-scoped guest command runs in its own guest session tagged with the lease, and the daemon counts its own
calls per lease. A lease that is invalidated or released stays held until Hive has killed that lease's guest
processes and its calls have settled (or, failing that, stopped the computer); only then is the next lease granted
or the membership/profile change committed. See [computers.md](computers.md#shared-computers-and-turns).

Changing a profile reconfigures the runtime while retaining the computer home. Chat/task history stays with each
agent. Runtime changes are separate from profile changes and are not offered as automatic cross-runtime migration.
File export stages one regular file in daemon-private storage, records its size and SHA-256, and asks against that
immutable snapshot. Staging and consumption validate the same agent membership, resource revision and live lease.
Staged bytes are dropped when their lease ends or their approval is denied or expires, and the whole staging folder
is cleared at startup and shutdown.

At startup the daemon first claims its data folder (`daemon.lock`, holding its pid). A second daemon on the same
folder waits up to 8 seconds for the first to exit and otherwise stops without touching anything, so its start-up
cleanup can never stop the first one's computers. The lock holds the pid and its start time, so a lock left by a
daemon that died is taken over even when its pid now belongs to another process. It then reconciles
only resources belonging to its own runtime identity before opening the listener.
On shutdown it prevents new debounced state broadcasts before draining runs and stopping resources, then closes the
database. Hive is a macOS host app; Linux is only the guest OS.

## A message, end to end

1. You send a message (notch, board) → `POST /api/agents/:id/messages`.
2. `Runner` queues it. Agents handle one message at a time; extra messages show as "+N queued".
3. The engine runs in the agent's workspace, `~/.hive/agents/<id>/workspace`, plus any folders you granted.
   - **Claude Code:** `claude -p` with stream-json. The prompt goes to stdin. The identity goes in
     `--append-system-prompt`. Sessions continue with `--resume`.
   - **Codex:** `codex exec --json`, continued with `codex exec resume <thread>`. The identity is prepended to the
     first message.
4. Streamed text shows up live (WebSocket `delta`). The final reply is stored as a message, and usage is stored
   on the run.
5. When Claude wants a tool that needs permission, it calls `mcp__hive__approve`. That MCP server posts to
   `/internal/approvals` and long-polls until you decide (see [agents.md](agents.md#approvals)).
6. After the result event the daemon kills the whole process group 2 s later, because Claude can linger with
   MCP children attached.

## Data (`~/.hive`, or `$HIVE_HOME`)

| Path | Content |
|---|---|
| `hive.db` | agents, messages, runs (cost/tokens), approvals |
| `hive.db` (`computers`, `agents.computer_id`) | persistent computer resources and agent assignments |
| `token` | dev only (`make dev`): the UI secret (0600). Hive.app passes its secret on stdin and never writes it |
| `agents/<id>/workspace` | default working folder of each agent (deleted with the agent) |
| `runtime/<id>.mcp.json` | MCP config handed to Claude (0600, contains that run's token) |
| `hive.log`, `daemon.out` | daemon logs. A run's end line is one line of at most 500 characters, with CR, LF and other control characters escaped, so engine output can't forge log lines |

## Security model

- The daemon listens on `127.0.0.1` only.
- `/api` and `/ws` need the UI secret; `/internal` needs a per-run token bound to one agent, so an agent can ask
  for approval but never decide one (see [daemon-api.md](daemon-api.md#auth)). Requests with a `Host` other than
  `127.0.0.1:<port>` / `localhost:<port>`, or a browser `Origin` other than the daemon's own, are rejected, so
  websites can't drive it.
- Public endpoints: `/health`, avatars, and the static board files. The board itself needs the UI secret. In the
  app it asks for it over a script bridge that answers only the board's main frame on the daemon's origin; the
  board's web view keeps no data and its links to other sites open in your browser. The URL never carries it.
- Dev flow without the app: `make dev` uses `~/.hive/token` as the UI secret. Open `http://127.0.0.1:47321`, paste
  the token into the field the board shows (`pbcopy < ~/.hive/token`); it stays in that tab's `sessionStorage`.
- The engine child inherits the daemon's environment minus `HIVE_TOKEN`, `HIVE_SECRET*`, `GH_TOKEN`,
  `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `CLAUDE_CODE_USE_POWERSHELL_TOOL`, with `PATH` extended.
- Claude agents: anything beyond reading needs your approval unless the agent is in *accept edits* mode or a rule
  allows it. Codex agents are confined by Codex's own sandbox (see [agents.md](agents.md#codex)).
