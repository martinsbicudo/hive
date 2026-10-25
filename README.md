<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/kit/export/horizontal/hive-horizontal-white-1200.png">
    <img src="brand/kit/export/horizontal/hive-horizontal-black-1200.png" width="320" alt="Hive">
  </picture>
</h1>

<p align="center">
  A local team of AI agents that lives in your Mac's notch.<br>
  They run on the Claude Code or Codex login you already have, and ask before they act.
</p>

Each agent has a face, a name and a job ("Josh · Software Engineer"), runs on **Claude Code** or **Codex** with
your existing login, and asks before it touches anything on your computer. There are no API keys, accounts or
telemetry; everything runs on your Mac and lives in `~/.hive`.

- **Notch on every screen.** Hover the top of any display to see who's working, approve actions, message an agent
  or check spend. Each screen picks its own style (attached to the notch, a floating island, a small dot, or hidden)
  and its own size and distance from the top.
- **Agents with identity.** Every agent gets a generated avatar, a name (yours or suggested) and a role.
- **Claude Code or Codex per agent**, with automatic model choice.
- **Approvals.** File edits and commands wait for Allow / Always allow / Deny, from the notch or the board.
- **Spend at a glance.** Today / 7 days / month for Claude Code, tokens for Codex, only for engines your agents use.
- **Schedules, budgets and a kill switch.** Agents can wake on a schedule, have daily budgets next to global limits,
  and "Pause everything" stops it all from the notch, the menu bar or the board. Banners tell you about approvals,
  budget hits and failed runs.
- **Board.** A web app (opened from the notch or the menu bar) to create agents, chat with them, run a kanban of
  tasks they hand to each other, and review usage.
- **Virtual computers.** An agent can work on an isolated Linux computer (on OrbStack or Docker Desktop; terminal, browser or full desktop)
  instead of your Mac, and you can watch its screen live. Several Claude Code agents can share one computer from the
  board's Computers page; they take turns and see the same files. Anything crossing between your Mac and a virtual
  computer asks you first.

Hive has finished **step 6** of its roadmap (integrations and templates). See [docs/roadmap.md](docs/roadmap.md).

## Requirements

- macOS 26 or later
- Node.js 24+ (`brew install node`)
- At least one engine, logged in: [Claude Code](https://claude.com/claude-code) (`claude`) or Codex (`codex`)
- Xcode Command Line Tools (to build)
- Optional, for virtual computers: OrbStack 2.2.5 or later (recommended) or Docker Desktop 4.44.3 or later, running. The board can set either one up for you

## Install

```sh
make deps      # node packages for the daemon and the board
cp scripts/signing.env.example scripts/signing.env   # once, if missing
make cert      # once: local signing identity, so macOS permissions survive updates
make install   # builds Hive.app, installs it to /Applications and opens it
```

The Hive mark (three stacked cells) appears in the menu bar and a notch at the top of each screen. Open the board
(menu bar mark → Open Board, or
the board button in the notch) and create your first agent.

## How Hive runs: the app and its daemon

Hive is two processes:

- **Hive.app**: the notch, the menu bar mark and the board window.
- **The daemon**: a Node process that holds all state and runs the agents. Its code ships inside the app
  (`Hive.app/Contents/Resources/daemon`).

When the app opens, it starts the daemon as a **child process**:
`node /Applications/Hive.app/Contents/Resources/daemon/src/main.ts`. Hive does not install a system service or a
LaunchAgent.

- **Where it listens:** only on `127.0.0.1:47321`, so nothing outside your Mac can reach it.
- **Where data lives:** `~/.hive` holds the database, logs and each agent's workspace.
- **Quit Hive = the daemon stops.** Quitting from the menu bar mark (Quit Hive, ⌘Q) stops the daemon and every
  running agent. Nothing keeps running with the app closed.
- **If the daemon crashes, the app starts it again.** Before talking to a daemon, the app checks that it is really
  its own: the daemon has to prove it holds Hive's secret. A different program on port 47321 is never trusted; the
  app shows "Port 47321 is used by another program".
- **Schedules need the app open.** Wakes only fire while Hive is running. A wake that came due while Hive was closed
  runs once when you open it again; it doesn't repeat for every slot it missed.
- **Start with your Mac:** turn on **Launch at Login** in the menu bar mark. macOS then opens Hive when you log in,
  and Hive starts the daemon. It's off until you turn it on. You can also manage it in System Settings → General →
  Login Items.
- **Updating:** `make install` replaces the app and restarts it, which restarts the daemon too. Your agents and
  history in `~/.hive` stay.

Developers: `make dev` runs a daemon by hand on the same port. If one is already answering when the app starts, the
app adopts it instead of starting its own. See [docs/development.md](docs/development.md).

## Use

| Where | What |
|---|---|
| Hover the notch | Expand it. Tabs: **Activity**, **Agents**, **Approvals**, **Usage** |
| Notch → Agents | Pick an agent, send it a quick message, stop it, or open its chat |
| Notch → Approvals | Allow, Always allow or Deny what an agent wants to do |
| Notch → ⚙ (sliders) | Style of the notch on *this* screen; **Size and position…** opens Notch Settings |
| Menu bar mark | Open Board · Notch style per screen · Notch Settings… (width, height, distance from top, per screen) · Launch at Login · Quit. A number next to it = approvals waiting |
| Board | Create/edit agents (avatar, name, role, engine, model, instructions, folders), chat, usage |
| Board → New agent | Describe it to the Architect, start **From a template** (Code Reviewer, Daily Briefing, Inbox Assistant, Researcher, Marketing Writer, Lead Finder, Content Creator), or fill in the form |

### Connectors and templates

In the agent form, tick **Connectors** (Mail, Calendar, Messages, GitHub) to let a Mac Claude Code agent use them.
Reading is free and arrives fenced as external content. Anything that sends or writes (an email, an event, an iMessage,
a GitHub comment or review) waits for you on a card showing exactly what will run, every time, with no "Always allow".
macOS asks once per app whether Hive may control it; revoke under System Settings > Privacy & Security > Automation.
GitHub reads need `gh` logged in to github.com. Details: [Connectors](docs/connectors.md).

**From a template** fills the form with a ready agent (and its schedules) for you to review. Nothing is created until
you click Create, and connectors a template turns on are listed in the form so you can untick them.

Your data lives in `~/.hive` (agents, chats, usage, approvals). Uninstalling the app keeps it.

## Documentation

- [docs/README.md](docs/README.md): index
- [Architecture](docs/architecture.md): app, daemon, board and engines, and how they talk
- [Agents and approvals](docs/agents.md): identity, engines, models, permission modes, approval rules, templates
- [Connectors](docs/connectors.md): Mail, Calendar, Messages and GitHub: what they read, what asks, macOS prompts
- [Notch](docs/notch.md): styles, size and position per screen, hover behaviour, tabs
- [Usage and spend](docs/usage.md): what the numbers mean
- [Daemon API](docs/daemon-api.md): HTTP and WebSocket endpoints
- [Development](docs/development.md): building, testing, dev flags, troubleshooting
- [Roadmap](docs/roadmap.md): steps 2–6
- [Brand guidelines](brand/kit/GUIDELINES.md): logo, colours, usage

## Contributing

Contributions are welcome. Hive builds from source on your own Mac; there are no binary releases, so the
[Install](#install) steps above are also the development setup.

### Development setup

```bash
xcode-select --install   # if you have neither Xcode nor the Command Line Tools
make deps                # node packages for the daemon and the board
cp scripts/signing.env.example scripts/signing.env && make cert   # once
make test                # daemon tests (node:test) and notch tests (Swift Testing)
make typecheck           # TypeScript for the daemon and the board
make dev                 # daemon with auto-reload; board at http://127.0.0.1:47321
make install             # build and run your change as the real app
```

The change loop is: edit, `make test` and `make typecheck`, then `make dev` for the daemon and board or
`make install` for the notch app. To run a second daemon next to the installed app, give it its own data folder and
port (`HIVE_HOME=/tmp/hive-dev HIVE_PORT=47400`); [development.md](docs/development.md) has the flags and the
troubleshooting table. The `make e2e-*` targets run real Claude Code agents and cost a few cents; unit tests never do.

### Optional: graft

Two small files configure [graft](https://www.npmjs.com/package/@nanonets/graft), a code index that some AI coding
agents use to search the repo: `.mcp.json` registers its MCP server for Claude Code, and `.ignore` keeps graft's
generated cards (git-ignored) searchable by ripgrep. You don't need graft to build, test or contribute:

- Without graft, `.ignore` has no effect.
- Claude Code asks once whether to enable the `graft` server from `.mcp.json`. Decline it and nothing changes; if you
  approve it without graft installed, it shows as failed under `/mcp` and everything else keeps working.
- To use it: `npm i -g @nanonets/graft`, then `graft build` in the repo.

### How it fits together

```
Hive.app (Swift) ─► starts the daemon, checks it holds the app's secret
  ├─ notch + menu bar ─┐
  └─ board window ─────┴─► daemon (Node, 127.0.0.1:47321) ─► SQLite and files in ~/.hive
     (React, served                 ├─► claude -p / codex exec ─► MCP server "hive" (tasks, computers, connectors)
      by the daemon)                ├─► osascript / gh, after your approval (connectors)
                                    └─► OrbStack or Docker Desktop (virtual computers)
```

| Area | Where |
|---|---|
| Notch, menu bar, board window | `notch/Sources/HiveNotch/` (`AppDelegate.swift`, `Notch*.swift`, `BoardBridge.swift`) |
| Starting and trusting the daemon | `notch/.../Daemon.swift`, `daemon/src/main.ts`, `server.ts`, `auth.ts`, `homeLock.ts` |
| Agents, runs and engines | `daemon/src/agents.ts`, `runner.ts`, `runPlan.ts`, `runProcess.ts`, `engines.ts` |
| Approvals and outward actions | `daemon/src/hubApprovals.ts`, `connectorApprovals.ts`, `trust.ts` |
| Tasks, schedules, budgets | `daemon/src/task*.ts`, `schedule*.ts`, `budgets.ts`, `control.ts` |
| Connectors | `daemon/src/connector*.ts`, `github*.ts`, `daemon/connectors/*.js` |
| Virtual computers and engines | `daemon/src/computer*.ts`, `engine*.ts`, `firewall.ts`, `sandbox/` |
| Board | `web/src/` (`api.ts` and the zod schemas in `schemas*.ts`, components in `components/`) |

[Architecture](docs/architecture.md) explains each part in depth, and [AGENTS.md](AGENTS.md) has the full file map.

### Product decisions

These are deliberate. Please open an issue to discuss before changing them:

- **Everything that leaves your Mac asks you first, every time:** an email, a message, a calendar event, a GitHub
  write, a file copied between your Mac and a virtual computer. The card shows exactly what will run.
- **AI only through the Claude Code or Codex CLIs**, with the user's own login. No API keys, no hosted service.
- **Local only.** The daemon listens on 127.0.0.1, data stays in `~/.hive`, and there is no telemetry.
- **Outside content is untrusted.** Mail, web pages, GitHub text and calendar text reach agents fenced as
  external content, and agents with connectors run with the stricter posture.
- **Virtual computers run only on OrbStack or Docker Desktop**, verified by their signed app. Hive follows the
  Docker context you selected and never changes it.

### Guidelines

- Every change to logic comes with unit tests, named after the behavior they protect. Tests use fakes: no real
  network, clock, Claude, Codex, Docker or Mac apps, and no sleeps. `make test`, `make typecheck` and
  `cd web && npm run build` must pass.
- Keep files under 300 lines and functions under 50, and match the existing style: descriptive names, no comments
  except a short *why* that the code can't express.
- TypeScript: no `as` casts (except `as const`), no `any`, no `!`, no `@ts-ignore`. Validate every boundary with
  zod `.strict()` schemas.
- Changes to trust, auth, validation or approvals need extra care: say in the pull request what changes and why,
  and never weaken a check silently.
- When behavior or settings change, update the matching page in `docs/` and, if it's user-facing, this README.
- AI agents working in the repo follow [AGENTS.md](AGENTS.md).
- Open a pull request that says what changed and how you tested it.

## License

[MIT](LICENSE) © Victor M. Bicudo. Contributions are accepted under the same license.
