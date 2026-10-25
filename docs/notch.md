# Notch

Hive puts a panel at the top centre of **every** connected screen and rebuilds them when displays are plugged in,
removed or rearranged.

## Styles (per screen)

| Style | Looks like | Default on |
|---|---|---|
| **Notch** | Black shape attached to the top edge that wraps the hardware notch, with a "wing" on each side | Screens with a notch (MacBook) |
| **Island** | Floating rounded pill, 6 pt below the top by default | External displays |
| **Minimal** | Small dot-sized tab at the top | — |
| **Hidden** | Nothing on that screen | — |

On screens without a notch, the *Notch* style draws a simulated one of the same shape.

Change it from the notch (⚙ sliders button → style for *this* screen) or from the menu bar (Hive mark → Notch on
<screen> → style). The choice is remembered per display UUID (`UserDefaults`, key `notchStyle.<uuid>`), so it
survives reconnects and display rearrangements.

## Size and position (per screen, per style)

**Notch Settings** (menu bar → Notch Settings…, or ⚙ in the notch → Size and position…)
opens a small window in the middle of the screen it edits, so the notch stays visible and changes show live. Pick
the screen, the style and drag the sliders:

| Style | Width | Height | Distance from top |
|---|---|---|---|
| **Notch** | Each side wing, 40–120 pt (default 84) | Extra below the menu bar, 0–10 pt (default 0) | — (attached to the top edge / camera notch) |
| **Island** | 150–320 pt (default 210) | 26–44 pt (default 34) | 0–40 pt (default 6) |
| **Minimal** | 36–120 pt (default 64) | 12–28 pt (default 18) | 0–40 pt (default 0) |

On a MacBook the notch never gets narrower than the camera notch itself; only the wings shrink. Below 80 pt per
wing (or 190 pt for the island) the collapsed content turns compact: one avatar instead of three, the working
count without the word "working", and the pause icon without "Paused".

Each screen keeps a layout for each style (`UserDefaults`, key `notchLayout.<uuid>.<style>`, JSON), so switching
the style and back restores its size. Saved values are clamped to the ranges above; anything unreadable falls back to
the default. **Reset this screen** removes that screen's layouts (the style stays).

## Collapsed

- Left wing: avatars of agents that are working. The Hive mark when nobody is.
- Right wing: "Paused" when Hive is paused, else ✋ and a count when approvals are waiting, otherwise "N working" or a moon when everyone sleeps.

## Expanded (hover)

Move the pointer over the collapsed shape to expand. Moving it away collapses after 350 ms. While collapsed the
panel ignores clicks, so the menu bar under it keeps working.

| Tab | Shows |
|---|---|
| **Activity** | Each running agent: avatar, name · role, what it's doing now (command, file, "Thinking…"), the task title when the run is a task run, elapsed time, queued messages. Click to open its chat. |
| **Agents** | All agents with status dots. Select one to message it, stop it, open its chat or, for a virtual agent, open its **Virtual computer** screen window. |
| **Approvals** | Pending requests with Deny / Always allow / Allow. Task approvals (`targetAgentId` set, never rememberable) read "<agent> needs your OK", show the full summary wrapped, and have only Deny / Allow |
| **Usage** | Spend per engine, only for engines that have agents (see [usage.md](usage.md)) |

Header buttons: **Pause / Resume** (the kill switch; while paused a bar under the header says so and has its own
Resume), **Board** (opens the board window), **Virtual computer** (the screen of the selected agent, or of
the first virtual agent; dimmed when no agent works on a virtual computer), **Style**.

The Agents tab shows **Next wake** (time, "tomorrow 09:00" or a weekday) for an agent with an enabled schedule.
The menu bar item has **Pause Everything** / **Resume** (it follows the state) and shows ⏸ next to the icon while paused.

## Notifications

The app listens for the daemon's `notify` events and posts a banner (UserNotifications; it asks for permission at
launch) for a new approval, a budget hit, a failed run and a pause. The banner text is exactly the daemon's `text`,
never tool input. Clicking an approval or pause banner opens the notch on the Approvals tab; a budget or failed
banner opens the board at that agent (or at the task when the event carries one). The unbundled dev build
(`swift run`, no bundle identifier) skips notifications.

## The daemon dying

If the daemon the app started and verified exits later, the app starts it again through the same health-proof flow.
If something else holds the port by then, it shows "Port … is used by another program" and sends no secret.

The task title comes from the optional `taskId` / `taskTitle` fields of an `activity` item; rows without them look as before.

Activity rows and the agent detail show computer steps as `Computer: <command>` (for `computer_run`) or
`Computer: <action> <detail>`.

## Screen window

One window per virtual agent, titled "<name> · Virtual computer". The top bar shows the computer's state (and its
error detail), **Start** / **Stop**, and **Reconnect**. When the computer reaches `running` (at open or after a
restart), and on every Reconnect, the window fetches fresh screen secrets from `GET /api/agents/:id/computer/screen`
with the in-memory UI secret and loads `http://127.0.0.1:<daemonPort>/screen/#port=…&token=…&password=…` into a
**brand-new web view** (`ScreenSurface`), with a fresh non-persistent data store and an empty back/forward list. Reusing
the old view wouldn't work: after the page clears its fragment, loading a new fragment is a same-document navigation,
so the page wouldn't rerun and the old secrets would stay in its history. The page connects to the
computer's websockify; you can use the mouse and keyboard on the desktop.

The web view is locked down (`ScreenWebGuard`):

- `WKWebsiteDataStore.nonPersistent()`: no cookies, cache or storage survive the window;
- no script message handlers and no user scripts, so the page has no bridge to the app;
- JavaScript is off by default and turned on only for the navigation it allows;
- navigation is allowed only to exactly `http://127.0.0.1:<daemonPort>/screen/` (main frame, no query, no user
  info); everything else is cancelled, including responses from redirects;
- `createWebViewWith` returns `nil` (no popups or new windows); no back/forward gestures, link previews or Web
  Inspector.

The board's **Open screen** inside the app's board window goes through the same path: the board window's UI
delegate refuses every popup and, when the popup is the daemon's `/screen/` page carrying `agent=<uuid>`, opens this
native window instead (which fetches its own secrets).

## Implementation notes

- One borderless, non-activating `NSPanel` per screen at `mainMenuWindow + 2`, joining all Spaces and full-screen
  apps. It always has the expanded size (580×400), so expanding never moves the window. Only the drawn shape
  changes.
- Hover is detected with global and local `mouseMoved` monitors against hot zones from `NotchGeometry`, because a
  window that ignores the mouse gets no tracking events.
- The hardware notch width comes from `NSScreen.auxiliaryTopLeftArea` / `auxiliaryTopRightArea`.
- UI state lives in the `@Observable` `NotchModel`, not in SwiftUI `@State`. The SwiftUI macros plugin isn't
  available when building with Command Line Tools only.
