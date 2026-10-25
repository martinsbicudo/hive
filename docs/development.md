# Development

## Layout

```
daemon/   Node orchestrator (src/, test/)
web/      board (React + Vite) → web/dist
notch/    Swift package: Sources/HiveNotch, Tests/HiveNotchTests, Resources (Info.plist, icon)
scripts/  build-app.sh, install-app.sh, create-cert.sh, signing.env.example (copy to signing.env, git-ignored)
brand/    concepts/ (logo exploration), kit/ (masters, exports, GUIDELINES.md, build.py)
```

## Commands

| Command | Does |
|---|---|
| `make deps` | Node (brew, if missing) + npm packages |
| `make cert` | Creates the "Hive Local Signing" identity in its own keychain, once |
| `make dev` | Builds the board and runs the daemon with `--watch` on :47321 |
| `make test` | `node --test` for the daemon + `swift test` for the notch |
| `make typecheck` | `tsc` for daemon and board |
| `make e2e-step6` | Templates and connectors with a fake `gh` and `osascript` (`daemon/test/e2eStep6.test.ts`; nothing real runs) |
| `make build` / `make install` | `build/Hive.app` / install to `/Applications` and launch |
| `make uninstall` | Removes the app; `~/.hive` stays |

### Running the app against a dev daemon

Start `make dev`, then run the Swift app. It finds the daemon already listening and uses it:

```sh
cd notch && swift build && .build/debug/HiveNotch
```

`HIVE_DAEMON_DIR=<repo>/daemon` makes the app spawn the daemon from source instead of the bundle.

### Isolated data

`HIVE_HOME=/some/dir HIVE_PORT=47399` runs everything (app and daemon) against another data folder and port.
Daemon tests always run with a temporary `HIVE_HOME`.

### Dev flags (notch app)

| Flag | Effect |
|---|---|
| `--preview <activity\|agents\|approvals\|usage>` | Opens every notch expanded on that tab |
| `--snapshot <dir>` | Waits 3 s, writes `screenN-<style>-{collapsed,<tab>}.png` for each screen, quits. Works without Screen Recording permission. |

## Toolchain notes

- The daemon runs `.ts` directly on Node 24. `tsconfig` uses `erasableSyntaxOnly`, so no enums, namespaces or
  parameter properties.
- With Command Line Tools only (no Xcode), SwiftPM sometimes doesn't load the Swift Testing macro plugin
  ("plugin for module 'TestingMacros' not found"). `make test` passes
  `-plugin-path $(xcode-select -p)/usr/lib/swift/host/plugins/testing` to avoid it. For the same reason the UI
  avoids SwiftUI's `@State` and keeps state in `@Observable` models.
- Signing with a stable local identity keeps macOS permissions (and Launch at Login) across rebuilds.

## Troubleshooting

| Symptom | Check |
|---|---|
| Notch says "Hive isn't running" | `~/.hive/daemon.out`, `curl 127.0.0.1:47321/health`, `node --version` (24+) |
| Chat says "claude/codex isn't installed" | `which claude` / `which codex`. Hive searches `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` |
| Agent stuck "working" | Stop it from the notch. Interrupted runs are marked failed on the next daemon start |
| Daemon exits with "another Hive daemon is using …" (in `hive.log`) | Another daemon holds that data folder, for example the installed app while you run `make dev` on `~/.hive`. Quit one, or give the dev daemon its own `HIVE_HOME` and `HIVE_PORT`. If no Hive daemon runs at all (`pgrep -fl daemon/src/main.ts`), remove `daemon.lock` in that folder |
| Port in use | A `make dev` daemon using `~/.hive/token` is reused. Anything else on the port (that can't prove it holds that token) gets "Port 47321 is used by another program" |
