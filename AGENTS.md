# AGENTS.md

Guide for AI agents (Claude Code, Codex, others) working in this repo. `AGENTS.md` is the source of truth; `CLAUDE.md`
only imports it. If `AGENTS.local.md` exists (git-ignored, a maintainer's own notes), read it too.

## What Hive is

Hive is a macOS app that lives in the notch. Each agent has a face, a name and a job, runs on Claude Code or Codex
with the owner's existing login, and asks before any action that leaves the owner's Mac. It has three parts: a
Swift notch app (`notch/`), a Node 24 TypeScript daemon that owns all state and runs the engines (`daemon/`), and a
React board (`web/`) that the app shows in a WKWebView.

## Start here

1. This file: conventions, commands, security rules, working rules.
2. `README.md`: what Hive does, install, and the contributing guide.
3. `docs/README.md`: index of the user and design docs.
4. `docs/architecture.md`: processes, data, lifecycle, security model.

## Repo map

Top level:

- `README.md`: user guide and contributing guide. `LICENSE`: MIT.
- `Makefile`: all build, test, install and e2e entry points. Run `make help`.
- `scripts/`: build and install. `build-app.sh` builds `build/Hive.app`; `install-app.sh` installs it to
  `/Applications` and launches it; `create-cert.sh` makes the local signing identity; `e2e-*.sh` are the real-agent
  checks. `signing.env.example` is the template for `signing.env`, which is git-ignored and must not be read.
- `brand/`: logo concepts (`concepts/`) and the brand kit (`kit/`: SVG masters, exports, `GUIDELINES.md`,
  `build.py`, `board.json`). The kit still has the old honey colours; the app icon and the README lockups are the
  current monochrome mark.
- `sandbox/`: `computer/` and `netns/`, the images used by virtual computers (`hive/computer`, `hive/netns`).
- `docs/`: user and design docs (see below).
- `build/`: build output (git-ignored); `make clean` removes it.

### daemon/

- `package.json`, `tsconfig.json`: Node 24, runs `src/*.ts` directly (type stripping).
- `src/`, grouped by area:
  - Agents and identity: `agents.ts`, `agentFields.ts`, `avatars.ts`, `templates.ts`, `models.ts`, `types.ts`,
    `version.ts`.
  - Engines and runs: `engines.ts`, `runner.ts` (`runnerPrepare.ts`, `runnerIdle.ts`, `runnerFailures.ts`),
    `runPlan.ts`, `runProcess.ts`, `runState.ts`, `runGate.ts`, `runJobs.ts`, `runTokens.ts`, `process.ts`,
    `commandRunner.ts`, `usage.ts`, `loopGuard.ts`, `virtualClaude.ts`.
  - Hub and state: `hub.ts`, `hubState.ts`, `hubApprovals.ts`, `db.ts`, `sqlRows.ts`, `settingsStore.ts`, `paths.ts`,
    `homeLock.ts` (one daemon per data folder), `export.ts`, `health.ts`, `log.ts`, `notify.ts`.
  - Tasks: `taskCore.ts`, `taskService.ts`, `taskStore.ts`, `taskActions.ts`, `taskApprovals.ts`, `taskGate.ts`,
    `taskInput.ts`, `taskPrompt.ts`, `taskRoutes.ts`, `hiveTools.ts`.
  - Schedules: `scheduler.ts`, `scheduleService.ts`, `scheduleStore.ts`, `scheduleInput.ts`.
  - Budgets and kill switch: `budgets.ts`, `control.ts`, `controlRoutes.ts`.
  - Connectors, GitHub, Mac and trust: `connectors.ts`, `connectorList.ts`, `connectorTools.ts`,
    `connectorApprovals.ts`, `connectorRoutes.ts`, `githubTool.ts`, `githubFlags.ts`, `githubPolicy.ts`, `mac*`
    (`macInput.ts`), `jxa.ts`, `outwardDisplay.ts`, `trust.ts`.
  - Architect: `architect.ts`, `architectPrompt.ts`, `architectProposal.ts`, `architectGuard.ts`,
    `architectRoutes.ts`.
  - Virtual computers: resources and sharing (`computerStore.ts`, `computerTypes.ts`, `computerManagement*.ts`,
    `computerMembership.ts`, `computerOwnership.ts`, `computerLeases.ts`, `computerLeaseExec.ts`), lifecycle
    (`computers.ts`, `computerService*.ts`, `computerReconcile.ts`, `computerGuest.ts`, `computerImages.ts`,
    `computerArgs.ts`, `computerInput.ts`, `computerRoutes.ts`, `runtimeCapabilities.ts`), exports
    (`exportStaging*.ts`), `docker.ts`, `tar.ts`, `firewall.ts` (keeps a computer off private ranges).
  - Engines for computers (OrbStack, Docker Desktop): `computerEngines.ts`, `computerRouting.ts` (per-computer
    binding), `engineSocket.ts`, `engineAttest.ts` (socket, signature and version checks), and the guided setup
    (`engineSetup*.ts`, `engineDownload.ts`, `engineVerify.ts`, `engineInstall.ts`).
  - Server and routes: `server.ts` (HTTP + WebSocket, token and origin checks), `auth.ts`, `secret.ts`,
    `requestTarget.ts`, `httpError.ts`, `main.ts` (entry point), `screenPage.ts`.
- `mcp/`: `hive-mcp.ts` (MCP server "hive"), `computerTools.ts`, `taskTools.ts`, `connectorClient.ts`,
  `macToolDefinitions.ts`.
- `connectors/*.js`: JXA (macOS JavaScript for Automation) scripts run by the Mac connectors.
- `screen/`: the live screen page for virtual computers.
- `test/`: `node:test` suites (`*.test.ts`) plus fakes and fixtures. Key helpers: `fakeEngine.ts`,
  `fakeArchitect.ts`, `fixtures.ts` (`writeWhole` for atomic writes), `connectorFixtures.ts`, `githubFixtures.ts`,
  `macFixtures.ts`, `taskFixtures.ts`, `controlFixtures.ts`, `architectFixtures.ts`, `engineSetupFixtures.ts`.

### web/

- `src/`: `main.tsx`, `App.tsx`, `api.ts` (`request(schema, ...)`, the only way to call the daemon), `schemas.ts`,
  `schemasState.ts`, `schemasTasks.ts` (zod schemas for responses), `connectors.ts`, `tasks.ts`, `useTasks.ts`,
  `wake.ts`, `budgetMath.ts`, `proposal.ts`, `steps.ts`, `screenWindow.ts`, `engineSetup.ts`, `computerLabels.ts`,
  `runtimeCapabilities.ts`, `styles.css`, `computers.css`.
- `src/components/`: `Board.tsx` (main board), `Computers.tsx`, `ResourceCard.tsx`, `ComputerAccess.tsx`,
  `EngineSetup.tsx`, `ComputerPanel.tsx`, `Control.tsx`, `Panels.tsx`, `Chat.tsx`, `Thread.tsx`, `AgentForm.tsx`,
  `AgentSettings.tsx`, `NewAgentDialog.tsx`, `NewTaskDialog.tsx`, `TaskCard.tsx`, `TaskDrawer.tsx`,
  `TaskFields.tsx`, `ArchitectChat.tsx`, `ProposalNotes.tsx`, `ConnectorsField.tsx`, `TemplatePicker.tsx`,
  `RolePicker.tsx`, `ScheduleForm.tsx`, `Schedules.tsx`, `Budgets.tsx`, `OutwardCard.tsx`, `TokenField.tsx`.
- `public/`: static assets and the marks.
- `index.html`, `vite.config.ts`, `tsconfig.json`: Vite + React 19. Imports types from `daemon/src/types.ts`.

### notch/

- `Package.swift`: Swift package, no Xcode project. Swift 6.2, SwiftUI + AppKit.
- `Sources/HiveNotch/`: `main.swift`, `AppDelegate.swift` (menu bar item), `NotchController.swift`,
  `NotchPanel.swift`, `NotchView.swift`, `NotchStyle.swift`, `NotchLayout.swift`, `NotchSettings.swift`,
  `ExpandedView.swift`, `Tabs.swift`, `Models.swift`, `HubClient.swift` (WebSocket + REST), `Daemon.swift` (spawns
  the daemon), `BoardBridge.swift` (board window, secret bridge), `Screen*.swift` (virtual-computer screen windows),
  `OutwardCard.swift`, `Notifications.swift`, `BrandMark.swift`.
- `Tests/HiveNotchTests/`: `swift test` suites.
- `Resources/`: `Info.plist` (the app version), `AppIcon.icns`.

### docs/

- `README.md`: index. `architecture.md`: processes, data, lifecycle, security model.
- `agents.md`: identity, engines, models, approvals, tasks, connectors, wake and budgets, templates, Architect.
- `connectors.md`: Mail, Calendar, Messages, GitHub; send card; macOS Automation prompts.
- `daemon-api.md`: HTTP and WebSocket endpoints and auth.
- `notch.md`: notch styles, hover, tabs, screen window. `computers.md`: virtual computers and their engines.
- `development.md`: commands, dev flags, isolated data, troubleshooting. `usage.md`: what the spend numbers mean.
- `roadmap.md`: steps 1 to 6.

## Commands

Run from the repo root unless noted.

| Command | What it does |
|---|---|
| `make deps` | Node (brew, if missing) and npm packages for `daemon/` and `web/` |
| `make cert` | Creates the "Hive Local Signing" identity, once |
| `make dev` | Builds the board and runs the daemon with `--watch` on 127.0.0.1:47321 |
| `make test` | `cd daemon && npm test` (node:test) then `swift test` in `notch/` |
| `make typecheck` | `npx tsc -p .` in `daemon/` and `web/` |
| `make build` | `scripts/build-app.sh`, produces `build/Hive.app` |
| `make install` | Builds and runs `scripts/install-app.sh` (installs `/Applications/Hive.app`, restarts it). `make update` is the same |
| `make uninstall` | Quits and removes `/Applications/Hive.app`; `~/.hive` stays |
| `make e2e-computer` | Isolation check for virtual computers (OrbStack or Docker Desktop + Claude Code login) |
| `make e2e-tasks` | Tasks and agent-to-agent with real Claude Code (a few cents) |
| `make e2e-step4` | Wakes, budgets and pause with real Claude Code (a few cents) |
| `make e2e-step5` | Architect hardening canary and proposal with real Claude Code (a few cents) |
| `make e2e-step6` | Templates and connectors with fake `gh` and `osascript` (no cost, nothing real runs) |
| `make clean` | Removes `build`, `notch/.build`, `web/dist` |
| `make clean-computers` | Removes every Hive virtual computer (containers, networks, volumes, images) |

Direct commands:

- `cd web && npm run build`: board build, must be clean.
- `cd daemon && npx tsc -p .`: daemon type check.
- `cd daemon && npm test`: daemon tests only. Always through `npm test`, which sets a temporary `HIVE_HOME`; a bare
  `node --test` writes to `~/.hive`.

## Code conventions (strict)

TypeScript (daemon and web):

- Node 24 runs `.ts` directly. Use erasable syntax only: no `enum`, no `namespace`, no parameter properties.
- No `as` casts, except `as const`. No `any`. No non-null assertion `!`.
- No `@ts-ignore` and no `@ts-expect-error`.
- Validate at boundaries with zod `.strict()`: daemon request bodies and the board's responses (`request(schema, ...)`
  in `web/src/api.ts`). Never trust `body as T`.
- Comments only for a non-obvious why. No comments that restate the code.
- Files at most 300 lines. Functions at most 50 lines. Split by responsibility when a file grows.

Tests:

- `node:test` with fakes. No real network, no real time, no real Claude, Codex, Docker or Mac apps in unit tests.
- Do not wait with sleeps. Use "armed" marker files: the fake engine or architect writes a marker when it is ready
  and the test waits for the marker (see `daemon/test/fakeEngine.ts`, `fakeArchitect.ts`).
- Write fixture files atomically (`writeWhole` in `daemon/test/fixtures.ts`: write a temp file, then rename).
- Daemon tests always run with a temporary `HIVE_HOME`, never the real `~/.hive`.
- Swift tests live in `notch/Tests/HiveNotchTests`.

General:

- Match the style of the surrounding code. Small, focused changes; no drive-by refactors.

## Security model essentials

Full detail: `docs/architecture.md`, `docs/daemon-api.md`, `docs/agents.md`, `docs/connectors.md`, `docs/computers.md`.

- Every outward action needs the owner's approval: sending mail or a message, creating a calendar event, any GitHub
  write, copying content between the Mac and a virtual computer.
- Connector agents (Mail, Calendar, Messages, GitHub) run only on the Mac and only with Claude Code. Their posture is
  tainted: WebFetch always asks, and the user's own setup ("Use my setup") is forced off for them.
- External content (mail, web, GitHub text, calendar text) is wrapped with untrusted markers by `daemon/src/trust.ts`.
  Keep the wrapping on every path that brings outside content to an agent.
- Outward approvals are snapshot-gated in `daemon/src/connectorApprovals.ts`: the approval card shows exactly what
  will run, and what runs must match what was approved. Only one approval may be pending per agent.
- `gh` access is limited by closed tables in `daemon/src/githubFlags.ts` and `daemon/src/githubPolicy.ts`. Only
  github.com is allowed. Anything not in the tables is refused.
- Codex has no per-action approvals. It runs in Codex's `workspace-write` sandbox, which blocks Apple Events, so Codex
  agents cannot use the Mac connectors or virtual computers.
- Virtual computers run only on OrbStack or Docker Desktop, attested by the user's own socket and the signed process
  serving it. Hive reads the selected Docker context and never changes it.
- The daemon listens on 127.0.0.1 only. `/api` and `/ws` need the UI secret; `/internal` needs a per-run token bound
  to one agent. Host and Origin headers are checked.
- Never weaken these controls silently. A change to trust, auth, validation or approvals needs a careful review and
  must say in its pull request what it changes and why.

## Working rules for agents

- Never touch the installed `/Applications/Hive.app`, port 47321 or `~/.hive` during tests. Tests use scratch
  daemons on scratch ports and a temporary `HIVE_HOME`.
- Never read or print `scripts/signing.env` (git-ignored; it holds a keychain password). `scripts/signing.env.example`
  is the template.
- The board's UI secret is passed from the app to the daemon on stdin (`HIVE_SECRET_STDIN=1`). `~/.hive/token` does
  NOT authorize `/api` of the installed app. Do not try to extract the secret from the app, the daemon or the
  keychain. To inspect state read-only, use `sqlite3` on `~/.hive/hive.db`.
- Outward actions (send mail or message, GitHub writes) must be approved by the human on the Hive card. An agent must
  never approve on the owner's behalf, through the API, the notch or any script.
- Before a commit, check the changes against the conventions above and run `make typecheck`, `make test` and
  `cd web && npm run build`.
- Keep `docs/` and `README.md` updated when behaviour or settings change.

## Driving and checking the real app

- The board is a WKWebView inside Hive.app (`notch/Sources/HiveNotch/BoardBridge.swift`), not a browser tab.
  Browser automation cannot reach it. Open it from the menu bar item ("Open Board") or the notch, and drive it with
  an OS-level accessibility tool. Hive is an accessory app, so it may not show up in app lists by name.
- React-controlled inputs: setting a value through accessibility may not stick. Click the field, then paste the text.
- The accessibility tree sometimes stays blocked; relaunching the app usually restores it, and it is always blocked
  while the screen is locked.
- The notch panel appears as a "system dialog" element. Its buttons have no labels; their order is: tabs, pause,
  board, screen, settings.
- After UI changes, take a deterministic screenshot and look at it.
- zsh does not word-split unquoted variables; run helper scripts with bash.
- `make install` replaces the installed app and restarts it.
