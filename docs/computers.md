# Virtual computers

Hive runs on macOS. An agent can work on **your Mac** (the default) or on its own **virtual computer**: a Linux
environment in a local container runtime, isolated from your Mac. Linux is the guest environment; Hive itself does
not support Windows or Linux hosts. Pick it under "Where it works" when creating or editing an agent.

| | Your Mac | Virtual computer |
|---|---|---|
| Engines | Claude Code, Codex | Claude Code only |
| Files | Its workspace plus the folders you grant | Its own disk inside the computer |
| Your accounts, keychain, local network | Reachable (with approval) | Not reachable |
| The web | Yes | Yes |
| Approvals | Asks before acting | Acts freely inside the computer; exporting a file to your Mac always asks |
| Connectors | Allowed | Not allowed |

Switching an agent between the two starts a fresh session.

Codex virtual agents are currently disabled. The installed Codex CLI 0.164 can run with its host shell and image tools
disabled, but non-interactive turns still reject a mutating `computer_run` MCP call before it reaches Hive. The daemon
rejects a Codex agent assigned to a virtual computer with “a virtual computer works with Claude Code only”; the form
also explains that Codex stays disabled until its restricted adapter passes the isolation probe.

## Requirements

One of two Docker engines, running as Docker's selected context:

- **OrbStack 2.2.5 or newer** (recommended: lighter on memory and battery), or
- **Docker Desktop 4.44.3 or newer.**

Hive follows the context you selected (`docker context show`) and never changes it. Before using an engine it
proves which one it is, instead of trusting what the engine says about itself:

1. the socket, after following symlinks, must be exactly your own `~/.orbstack/run/docker.sock` or
   `~/.docker/run/docker.sock`, owned by you, in a folder nobody else can write;
2. every process serving that socket must be the vendor's signed program (`codesign` requirement with OrbStack's
   or Docker's bundle identifier and Team ID, checked on the running process by its pid), and the executable the
   kernel reports for it must sit inside the vendor's signed app bundle;
3. the engine's own report must agree (`OperatingSystem` "OrbStack", or a "Docker Desktop" platform name), and the
   version must meet the floor (OrbStack's from its app bundle, Docker Desktop's from its platform name).

Anything else (a remote or TCP endpoint, Colima, a plain Docker Engine, another user's socket, a socket linked to an
unexpected place) is refused. The board shows the check's result as the engine's status. Hive checks the selected
engine again when you start a computer, so an engine you start or set up later works without restarting Hive.

### Setting up an engine from the board

If neither engine is installed, or one is installed but stopped, the **Engine** section of the Computers page offers
**Set up OrbStack** / **Set up Docker Desktop** or **Start …**. Hive asks first and lists the exact steps, then
shows one progress bar:

1. check this Mac: macOS 14 or newer, 15 GB free, `/Applications` writable, the app not already there;
2. download the official DMG from the vendor's own address only (`orbstack.dev` / `desktop.docker.com`, HTTPS, at
   most 3 redirects to listed hosts, size-capped, aborted if it stalls), into a private folder under
   `~/Library/Caches/Hive/setup`;
3. verify the DMG's signature and notarization for the vendor's Team ID before mounting it, mount it read-only, check
   that it holds only the expected app, and verify the app (signature, notarization, bundle identifier, version);
4. copy it into `/Applications` through a private staging folder, verify the copy again, and move it into place only
   if nothing is there (nothing is ever overwritten). The copy drops the download's quarantine mark: with it, macOS
   runs the app from a translocated copy where OrbStack can't start its engine, so Hive's own signature and
   notarization checks are the gate;
5. open the app and wait for its engine, then build Hive's images for the profiles your computers use.

Hive uses no password and never edits your shell or Docker settings. The engine's own first start is yours: OrbStack
shows its terms, may ask for your password to install its helper, adds lines to `~/.zprofile` and `~/.ssh/config`,
makes itself Docker's selected context and may offer to migrate from Docker Desktop; Docker Desktop shows its
subscription terms, may ask for your password and selects its own context. Hive never answers those windows.
You can cancel until the copy into `/Applications` starts; the temporary folder is always removed and the DMG
detached. Setup is refused while a computer is running or starting, and **Pause** cancels it.

### Each computer keeps its engine

A computer's files (`hive-home-<id>`) live inside one engine. At its first start Hive records that engine. Computers
made by an older Hive are bound to Docker Desktop, the only engine those builds used, even when it isn't running. If you later switch Docker's context to the other
engine, that computer won't start there: the board says where its files are and offers **Move to <engine>**, which
starts it with an empty home in the new engine and leaves the old home untouched in the old one (moving it back
later brings that home back). Pause, idle stops, quitting and the start-up cleanup reach every engine that is running, each
through its own socket.

The first start builds the selected profile image and network guard from `sandbox/`; that takes a few minutes,
during which the agent's computer shows "Preparing the virtual computer". Later starts take seconds.

## Computer profiles

- **Terminal** is a small Debian command-line environment with no screen.
- **Browser** adds Chromium in Openbox, with a screen you can watch and control. Chromium opens on a blank page as
  soon as the session starts, so the screen is never just black; `computer_open` opens its URLs in that same
  Chromium.
- **Desktop** adds a full XFCE desktop, also with a screen you can watch and control.

A start returns once the window manager is up, and `computer_open` returns once a Chromium window is visible (each
wait is capped at about 15 and 10 seconds and never fails the call), so a screenshot taken right after a cold start
or an open shows the desktop or the page rather than a black screen. Chromium's "Restore pages?" bubble is turned
off, since stopping a computer always ends Chromium abruptly.

Changing a profile stops and reconfigures the container while keeping the same `/home/agent` volume. Chat and task
history stays attached to the agent. Profiles work the same on OrbStack and Docker Desktop.

## What the agent can do

The agent drives its computer only through Hive's tools. It has no shell, file or web-fetch tools on your Mac.

| Tool | Does |
|---|---|
| `computer_run` | Runs a shell command in the computer (up to 10 min; output capped at 30 kB) |
| `computer_screenshot` | Takes a screenshot of the desktop |
| `computer_click`, `computer_type`, `computer_key` | Mouse and keyboard on the desktop |
| `computer_open` | Opens a URL in Chromium |
| `computer_read_file`, `computer_write_file` | Reads or writes a file in the computer |
| `computer_export` | Copies one file to `~/Downloads/Hive/<agent>/`. **Always asks you.** |

Web search also works. Everything else is turned off for virtual agents, whatever the agent's other settings say.
If a run ever reports a tool outside that list, Hive stops it.

The computer tools run without asking (they only touch the computer), matched by their exact names. Rules you saved
with "Always allow" are ignored for virtual agents, and "Always allow" isn't offered.

### How the agent is locked down

Hive starts Claude Code for a virtual agent with a fixed set of flags, ignoring the agent's folders, permission
mode, "use my setup" and saved rules:

- `--restricted`, `--tools WebSearch`, and Hive's MCP server only (`--mcp-config … --strict-mcp-config`);
- `--setting-sources project`, `--disable-slash-commands`, `--no-chrome`;
- `--settings` with `disableAllHooks`, `crossSessionInbound: "refuse"` and a `permissions.deny` list, repeated in
  `--disallowedTools` (Bash, Read, Write, Edit, WebFetch, Agent, Skill and the rest);
- `--permission-mode manual`, with no `--add-dir` and no `--allowedTools`;
- the working folder is an empty private folder, `$TMPDIR/hive-<id>/cwd`, emptied before every run.

Hive also reads the tool list Claude Code reports when a run starts. Anything beyond web search, the computer
tools and Hive's approval tool stops the run with an error in the chat.

## Shared computers and turns

Several agents can be attached to one managed computer. They take turns: a run holds the computer's lease while it
works, and the next member's run waits for it. The run prompt tells an agent on a shared computer which other agents
(by name, shown as data) use it, that its files, browser, running programs and screen are shared, and that anything
another agent left there is untrusted. An agent alone on its own computer is told it's its own.

When a lease ends (the run finishes or is interrupted, the agent is detached or moved, the computer's profile or
members change, it's deleted, or Hive pauses or quits), Hive ends that lease's work inside the computer before the
next lease starts or the change is saved:

- Every lease-scoped command (`computer_run`, click, type, key, read, write, screenshot and the copy an export
  makes) runs inside the computer in its own session (`setsid`) with a `HIVE_LEASE` marker, and records its
  session in `/tmp/.hive-leases/<lease>/`.
- When the lease is invalidated or released, Hive kills, as the `agent` user, every process in those sessions and
  every process that still carries that lease's marker, including background jobs and processes that started a
  session of their own. It waits for its own calls into the computer to settle, then kills once more.
- If the kill can't be confirmed while the computer is running, or the calls don't settle within 10 seconds, Hive
  stops the computer instead. Only then does the next member get it.
- A lease that never ran anything in the computer is released at once.
- The computer runs with `--init`, so the processes a kill leaves behind are reaped.

What survives a lease: files, and desktop state that belongs to the session rather than to one run. Chromium opened
with `computer_open` (or started by the browser session) and windows on the desktop stay open for the next member,
and so do programs started from the desktop itself (for example in a terminal window the agent typed into). A
command that deliberately clears the marker and starts its own session can also outlive the lease; that is why
everything another agent left on a shared computer is treated as untrusted.

Staged exports belong to the lease that made them: they are dropped when the lease ends, when you deny the export
or when its approval expires.

Your changes don't wait for a member to finish its turn. Detaching an agent, moving it to another computer,
changing a computer's profile, or deleting an agent that uses it cuts the members off: their runs stop (a run still
waiting for its turn is dropped), their leases end and the kill above runs, and only then is the change saved. One
exception: a member whose computer is still starting (the first start builds an image and can take minutes) is cut
off as soon as that start ends, so your change waits for it. Their queued work resumes afterwards (an agent that was
attached or detached drops what other agents queued for it), and a message sent to a member while the change is
being saved waits for it and then runs on the new configuration. Renaming a computer changes only its name and
interrupts nobody. Deleting a computer still needs it to have no members.

## Managing computers on the board

The board's **Computers** page shows the engine in use, OrbStack and Docker Desktop (installed, running, or a
**Set up** / **Start** button), and your computers. There you can:

- create a computer with a name and profile;
- rename it, or change its profile (the confirmation says what is lost: browser data when the new profile has no
  browser, desktop state when it has no full desktop);
- attach any Claude Code agent without connectors (Mac agents are switched to the virtual computer; the
  confirmation names the agents it will share with), or detach a member (it goes back to Mac access);
- delete a computer once it has no members.

A computer an agent had before it was attached to a shared one is listed too, with no members. It keeps that
agent's old home and is removed when the agent is deleted; **Share this computer** turns it into a shared computer
instead, keeping the same disk. In an agent's settings, the **Computer** section shows which computer it uses and
who it shares it with, and attaches, moves or detaches it. The Computer panel above the chat is titled with the
computer's name.

## Watching the screen

Click **Virtual computer** in the notch (Agents tab) or **Open screen** in the board's Computer panel. The screen
window shows the live desktop; you can take over the mouse and keyboard. The clipboard isn't shared.

The board shows a **Computer panel** above a virtual agent's chat: the state (not set up yet, preparing, stopped,
starting, running, couldn't start) with its detail, **Start** / **Stop**, and **Open screen** (enabled while it's
running). Open screen opens Hive's own screen page in a new tab, fetches fresh screen secrets with the board's UI
secret and hands them to that tab with `postMessage`, so they never appear in a URL or in the browser's history. In
the Hive app, the board hands the request to the notch's screen window instead. The chat shows the agent's
computer steps as `Computer: uname -a`, `Computer: click 120, 300` and so on.

The screen page and its noVNC copy (`@novnc/novnc` 1.7.0, pinned) are served by the daemon, never by the computer.
See [daemon-api.md](daemon-api.md#screen-page) and [notch.md](notch.md#screen-window).

## Lifecycle

- The computer starts on the agent's first message, or when you press **Start**.
- It stops after 15 minutes without use, or when you press **Stop**. Files in the agent's home stay.
- Deleting the agent deletes its own computer: containers, network and disk. An agent on a shared computer is
  taken off it; the shared computer and its home stay. A run queued for the agent being deleted is refused.
- When Hive starts, it stops leftover computers and removes those of deleted agents. It only touches its own:
  each Hive data folder has a random id (`~/.hive/instance-id`), and every container, network and disk it creates
  carries it as the `hive.instance` label. Computers of another Hive (say, a dev copy with its own `HIVE_HOME`)
  are left alone. Deleting, stopping or restarting a computer checks that label too before removing or stopping
  anything by name, and a start won't reuse an existing network or home volume with the computer's name unless it
  carries this Hive's label: it fails with "a Docker network/volume named … doesn't belong to this Hive" and leaves
  it untouched. The home of an agent that is still in Hive but now works on the Mac is kept.
- When Hive opens its database it repairs what an older build may have left: an agent it moved to the Mac is taken
  off its computer, and an agent it moved back to virtual rejoins its old computer (even if that one is now shared);
  either way the computer's revision is bumped, so no run keeps a stale lease on it.
- **Pause** stops every virtual computer Hive knows, including shared ones, ends every lease and refuses the runs
  waiting for one. Until you resume, nothing starts a computer or runs a command in one, not even **Start**. A start
  that was already under way when you paused finishes and the computer is stopped right after.

## How it's isolated

Each computer gets two containers and its own network:

1. **Network guard** (`hive-netns-<id>`). Installs a firewall and then just sleeps. It's the only container with
   a network capability (`NET_ADMIN`, nothing else). The firewall allows DNS to Docker's resolver and the open
   internet, and drops:
   - the bridge gateway (your Mac);
   - 0.0.0.0/8 (where OrbStack reaches your Mac, 0.250.250.254), the private ranges 10/8, 172.16/12 and 192.168/16
     (which hold Docker Desktop's internal 192.168.65.0/24), the link-local 169.254/16 (cloud metadata), 100.64/10,
     the benchmark range 198.18/15 (OrbStack's internal addresses) and multicast/reserved 224/3;
   - all IPv6.

   Before it starts the computer, Hive reads the guard's resolver, routes and installed rules. The guard's own
   subnet must lie inside the blocked list, its only routes must be Docker's default and link routes, the resolver
   must be Docker's own (or blocked), and the rules must match the expected list exactly: same rules, same order,
   nothing extra. If any of that can't be confirmed, the computer stays off and shows an error. Image tags carry a
   hash of their build files, so a changed firewall script rebuilds the guard on every install.
2. **Computer** (`hive-<id>`). Shares the guard's network, so it can't change the rules. Runs as an unprivileged
   user with no capabilities, `no-new-privileges`, a read-only root filesystem, and limits of 2 CPUs, 4 GB of memory
   and 512 processes. Its only disk is the volume `hive-home-<id>`. No host folders, no Docker socket and no
   environment variables from your Mac.

**The screen** runs as a separate user the agent can't touch. It's published on `127.0.0.1` only, and opening
it needs a token and a password. Both are generated fresh at every start and never stored on disk.

**Exports** are read inside the computer as the `agent` user (`tar` of that one file), so they can only reach what
the agent itself can read. Hive accepts exactly one regular file (no folders, links or devices) up to a size cap.
It's written without exec bits and marked as downloaded (quarantine), so macOS checks it before it opens. Every
export goes through the private staging folder (`~/.hive/.computer-exports`, mode 0700): the file is copied there
first, the card shows its name, size and SHA-256 (with hidden, bidi and zero-width characters in the name and path
shown as `[U+XXXX]`), and only those exact bytes are written after you approve. Staged files count against a quota
per agent (100 MB) and a global ceiling (200 MB). Hive clears the whole staging folder, including half-finished
`*.claimed` leftovers, when it starts and when it quits.

## Residual risks

- **Both engines share your home folder with their Linux VM.** A container or VM escape would reach it. On Docker
  Desktop, narrow Settings → Resources → File sharing to what you need; OrbStack mounts `/Users` in its VM. Hive
  never uses privileged containers, `SYS_ADMIN` or a disabled seccomp profile.
- **Your Mac's public address, VPNs and intranets.** The guard blocks private and special ranges, not public ones:
  a service on your Mac's own public IPv4, or a company network reached through a VPN on public addresses, is
  reachable like any web server.
- **OrbStack reaches containers from the Mac.** OrbStack routes your Mac to container addresses and `*.orb.local`
  names; a computer's screen is still behind its token and password.
- **Open web.** Anything the agent has seen inside its computer can leave through the web. Don't paste secrets
  into a virtual agent's chat.

## Cleaning up

```bash
make clean-computers   # removes every Hive container, network, volume and image
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Docker Desktop or OrbStack isn't installed" | Use **Set up** in the Engine section, or install one yourself |
| "… isn't running" / "… isn't answering yet" | Press **Start …** in the Engine section, or open the app; finish its own first-start windows |
| "OrbStack 2.2.5 or newer is required" / "Docker Desktop 4.44.3 or newer is required" | Update the app, then press Start again |
| "Hive supports Docker Desktop and OrbStack on this Mac's own socket" | Select one of them: `docker context use orbstack` or `docker context use desktop-linux` |
| "This computer's files are in X, but the active engine is Y" | Switch back to X (`docker context use …`), or use **Move to Y** on the computer (new empty home) |
| "a Docker network named … doesn't belong to this Hive" | Another Hive (or a tool) owns that name. Remove it yourself if it's stale, then press Start again |
| Stuck on "Preparing the virtual computer" | First build; check the engine has disk space. Details in `~/.hive/hive.log` |
| "The network guard couldn't confirm its firewall" | Restart the engine; if it persists, `make clean-computers` and start again |
