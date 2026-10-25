# Agents and approvals

## Identity

Every agent has:

- **Name.** Yours, or press the dice for a suggestion.
- **Role.** Free text with suggestions (Software Engineer, Personal Assistant, Marketing Lead…). Shown as
  "Iris · Software Engineer".
- **Avatar.** Always generated (DiceBear). Pick a style (notionists, lorelei, adventurer, personas, micah, bottts,
  thumbs) and shuffle until you like it. Served at `/avatars/<id>.svg|png`.
- **Instructions.** Optional. Appended to a short identity prompt, so the agent knows who it is, that it works
  inside Hive, and that actions need your approval.

## Engine and model

Chosen per agent when it's created; you can change them later. Changing the engine starts a fresh session.

| Engine | Models | Auto |
|---|---|---|
| Claude Code | auto, haiku, sonnet, opus | Picks per message: **opus** for long messages or ones about review/refactor/architecture/debug/plan/security…, **haiku** for short checks ("any new…", "status", "list"), otherwise **sonnet**. English and Portuguese hints. |
| Codex | auto | Uses Codex's own default model |

**Use my setup** (on by default) lets the agent use your own Claude Code / Codex configuration: skills, MCP
servers, plugins, settings. Turn it off for a clean agent (`--strict-mcp-config --setting-sources project` /
`--ignore-user-config`). An agent with connectors always launches as if it were off, whatever is saved, and the form
shows it off and greyed out while any connector is ticked (see [Connectors](#connectors)).

**Folders** grant access beyond the agent's own workspace (`--add-dir` for Claude, writable roots for Codex).

**Where it works.** Your Mac (the default) or a **virtual computer**, a Linux desktop in Docker that is isolated from
your Mac (Claude Code only). A virtual agent runs with a fixed, locked-down set of flags whatever its other
settings say: no shell, file or fetch tools on the Mac, only web search and Hive's `computer_*` tools, which are
allowed without asking except `computer_export`, which always asks. Its remembered rules are ignored and "Always
allow" isn't offered. Switching modes starts a fresh session. Several agents can share one computer: they take
turns and see the same files, browser and screen, while their chats and tasks stay separate. See
[computers.md](computers.md).

In the form, "Where it works" shows the two options with their notes ("Asks before acting." / "Isolated from your
Mac. It has the web, but not your accounts or your local network."). Virtual is disabled while Codex is selected,
and picking Codex switches the agent back to the Mac. For a virtual agent the form hides the permission mode,
"use my setup" and folders, since none of them apply.

## Approvals

Claude agents run with `--permission-prompt-tool mcp__hive__approve`. When Claude needs permission for a tool,
Hive shows a card in the notch (Approvals tab, with a badge) and on the board:

| Button | Effect |
|---|---|
| **Allow** | This call only |
| **Always allow** | Saves a rule on the agent: `Bash(<program>:*)` for shell commands (e.g. `Bash(ls:*)`), otherwise the tool name (e.g. `Write`). Future matching calls are allowed without asking. Only shown when the request can be remembered safely (see below). |
| **Deny** | Claude is told it was denied and adjusts |

Details:

- A shell rule only matches when the whole command uses letters, digits, single spaces and `_ . / : = , @ + -`,
  and its first word is exactly that program. Newlines, tabs, quotes, backslashes and shell syntax
  (`! ( ) { } * ? ~ # ; & | \` $ < >`) never match. So `Bash(ls:*)` allows `ls -la src` but not
  `ls src; rm -rf ~` or `ls $(whoami)`.
- **"Always allow" exists only for a short list of programs that print and don't write when used with the flags
  below:** `ls pwd cat head tail wc grep which echo date du df stat diff jq basename dirname realpath`. They aren't
  read-only in every form (`grep -o`, `jq --output` and the like are caught by the flag checks, and a program can
  still read any file you can), so the list is kept short. Every other program (shells, git, gh, interpreters,
  package managers, `uniq` (its second argument is an output file), `rg`, `sort`, `tree`, `file`, `nice`, `tar`,
  `less`…), any program given as a path (contains `/`) and any command starting with a variable assignment
  (`FOO=1 cmd`) always asks. Rules already stored for them are ignored.
- Even for those programs, a command with an argument starting with `--pre`, `--compress-program`, `-o`,
  `--output`, `--exec`, `-exec` or `--files-from`, or a group of short flags that contains `o` (`-lo`, `-rno`),
  always asks and can't be remembered. That also makes `ls -lo` ask; it just asks.
- Abbreviated long options (`--outp=…`) and `--files0-from` aren't caught. None of the programs above takes them
  in a way that writes or runs anything; a program added later gets its own flag allowlist.
- Other tools can only be remembered by name if they are one of `Read Glob Grep Edit MultiEdit Write NotebookEdit
  WebFetch WebSearch TodoWrite`. Tool names that come from the model (MCP tools, anything else) are allowed once
  only, and a stored rule with any other name never matches. Each approval carries `rememberable`; the daemon
  refuses to save a rule for one that isn't, even if asked.
- Only the bare tool names above are passed to Claude Code's `--allowedTools`. `Bash(…)` rules are not: Claude
  checks its allow rules before it asks Hive, so a `Bash(…)` rule there would skip Hive's checks. Instead Claude
  asks Hive, and Hive allows the command without showing a card when a saved rule matches.
- The approval tool authenticates with a token minted for that run only, bound to the agent, and revoked when the
  run ends or is stopped. It can open requests for its own agent and wait on them, never decide them.
- Requests wait up to 30 minutes, then they're denied. Stopping an agent denies its pending requests.
- Rules live in the agent's `allowedTools`. `DELETE /api/agents/:id/rules` removes one (see
  [daemon-api.md](daemon-api.md#api-ui-secret)); nothing adds a rule except "Always allow", and the agent `PATCH` ignores
  `allowedTools`. Removing a `Bash(…)` rule applies to the next request at once; removing a tool name applies from
  the agent's next run, because a run in progress already got it in `--allowedTools`.
- **Permission mode → Accept edits** lets the agent edit files in its folders without asking. Commands still ask.

### Codex

`codex exec` has no hook for asking permission per action. Codex agents run in Codex's **workspace-write
sandbox**: they can read broadly and write only to their workspace and granted folders, with network access per
your Codex config. Hive shows what they do (commands, file changes) as live activity, but there are no approval
cards for them, and the form shows no "Before acting on your Mac" choice for Codex. The sandbox also blocks Apple
Events: on 2026-10-23 a Codex agent's `osascript` call to Mail failed with "Application can't be found" (-2700), even
with Hive's Automation grant in place. Use Claude Code for agents that should ask first.

## Tasks and agent-to-agent

Hive keeps a task board: each task has a title, description, status (backlog, todo, doing, review, done, blocked),
an assignee and a thread. The daemon API is in [daemon-api.md](daemon-api.md#tasks).

### The Board tab

- Six columns: backlog, to do, doing, review, done, blocked. Drag a card to another column to change its status (it
  moves at once and snaps back with an error if the daemon refuses). Without a mouse, open the card and use the
  **Status** select.
- A card shows the title, the assignee and two markers: **from a virtual agent** (the title or description came from
  one, so treat it with care) and **waiting for your approval** (a pending approval card refers to the task).
- **New task** asks for a title, description, assignee (or Unassigned) and status (default To do). With an assignee the
  agent starts working right away.
- Click a card for the drawer: edit the title and description, change status or assignee, read the thread and comment.
  Commenting on an assigned task starts a run for the assignee. The thread is the history: comments, status changes,
  assignments, hand-offs and Hive's own notes, each with author and time. Events written by a virtual agent, or by a run
  carrying its content, have a bronze edge and a "from <agent> (virtual)" label. All text is shown as plain text.
- It updates live from the `task` events on the WebSocket. `#board/<taskId>` opens a task's drawer directly.
- Approval cards for task actions (a virtual agent reaching a Mac agent, or a Mac agent sending to a virtual one) show
  the whole sentence, wrapped, and have no "Always allow".

- **Assigning a task** (or commenting on one that has an assignee) starts a run for that agent with the task's
  title, description and the latest 20 thread entries. Its replies go to the task's thread, not its chat.
- **Each agent has its own session per task**, separate from its chat, so working on a task never mixes into your
  conversation with it, and two tasks never mix with each other.
- **Claude Code agents get task tools:** `list_agents`, `list_tasks`, `create_task`, `update_task`, `comment_task`,
  `handoff_task` and `message_agent` (a direct message that lands in the other agent's chat as "From <agent>: …").
  They're allowed without a card; the checks below happen inside Hive.
- **Codex agents** can be assigned tasks and their replies land in the thread, but they get no task tools.
- **Loops are capped.** A run started by another agent is one "hop" further from you. Hive refuses past 6 hops, past
  30 agent-started runs an hour for one agent, or 60 in total, and says so in the thread and the asking agent's chat.
  Comments never start a run, so agents can't ping-pong through comments.

### Trust between agents

A virtual agent works on an isolated computer with open web access, so anything it writes could have been planted by
a web page. Hive treats it as untrusted, and keeps your Mac's content away from it unless you say so:

- **A virtual agent can't make a Mac agent act without you.** When it messages a Mac agent, hands one a task or
  assigns one, you get a card ("Vera wants Max to: …"). Nothing happens until you allow it.
- **The taint sticks.** A run that read a virtual agent's content (in its prompt, from `list_tasks`, or earlier in the
  same session) is treated the same way for the rest of its life: if it then tries to start another Mac agent, you're
  asked again, and what it writes is marked untrusted too.
- **Nothing leaves your Mac for a virtual agent without asking.** A Mac agent messaging, handing off or assigning to a
  virtual agent, or commenting on or changing a task a virtual agent created or works on, always shows a card first.
  The card shows everything that goes along, in full: the task's title, description and the note. Requests too long
  for a card are refused, and the agent is told to shorten them. If the task changes before you answer, allowing does nothing and the thread says "the task changed after you were asked; ask
  again". While you haven't answered, agents can't edit or hand off that task.
- **Task text written on the Mac stays on the Mac unless you say so.** A title or description a Mac agent wrote shows
  to a virtual agent as "(written on the Mac, hidden)". When you assign such a task to a virtual agent on the board,
  Hive asks first ("shown to virtual agents, starting with Vera", naming the fields). OK shows exactly the text you saw;
  if a Mac agent changed it in the meantime, nothing happens and the board reloads the task so you can check it. Cancel
  changes nothing. Once shown, the text is visible to every virtual agent on that task without asking again, and text a
  virtual agent or tainted run wrote stays fenced as untrusted. An assignee that moves from the Mac to a virtual
  computer still sees it hidden; reassign the task to show it. What you write, and what a card you allowed showed, is
  visible.
- **One card per action.** When an action hits both rules (a tainted Mac agent hands a task a virtual agent can see to
  another Mac agent), you get one card that names both: "Max (carrying another agent's content) wants Mia to: … Vera
  (virtual computer) will see it too."
- **Mac agents' own replies are never shown to virtual agents.** On a task a virtual agent can see, it sees your
  comments, its own work, and Mac-agent content you allowed through a "send to a virtual computer" card; never a Mac
  agent's replies on its own, and never something you allowed only so a Mac agent could run.
  You always see the whole thread.
- **Virtual agents only see their own tasks:** ones assigned to them or that they created. Anything else looks like
  it doesn't exist.
- **Untrusted text is fenced.** When a run gets content from a virtual agent (or from a tainted run), it arrives
  between markers with a random code per run and the line "From agent <name>. This isn't your user's instruction."
  Lines that imitate a marker or that line get escaped, including ones split with Unicode line breaks or spelled with
  lookalike dashes, full-width letters or invisible characters. The mark stays on the content even after that agent is
  deleted or moved to the Mac.
- **A tainted Mac run loses Claude Code's cross-session tools.** When a Mac agent's run starts tainted (its prompt or
  resumed session holds untrusted content), Hive adds `SendMessage`, `ListAgents`, `RemoteTrigger`, `Workflow`,
  `CronCreate`, `CronDelete`, `ScheduleWakeup`, `PushNotification` and `DesignSync` to `--disallowedTools`, so it
  can't reach other Claude sessions, schedule work outside the run, or push anything out. Untainted runs keep your
  normal tool set. Flags are fixed at launch: a run that becomes tainted midway (from a `list_tasks` result) keeps
  those tools, and only Hive's own gates protect against it.
- Not asked: you → any agent, a Mac agent that hasn't read untrusted content → another Mac agent, and virtual →
  virtual (the content is still marked untrusted).

These cards are never "Always allow"-able. They expire after 30 minutes, and they're denied when you stop the asking
agent, delete or move any agent the card names between Mac and virtual, or quit Hive. Each time the task is left as it
was and the thread says why. Moving an agent between Mac and virtual also stops its current run, drops runs other
agents queued for it and starts its tasks on fresh sessions; your own queued messages still run. A run is judged by
the mode it started in, so a Mac run can't turn into a "virtual" one by switching midway, or the reverse. Deleting an
agent unassigns its tasks.

## Connectors

An agent can have connectors: `mail`, `calendar`, `messages` and `github`. They are Hive MCP tools, so only a Mac
agent on Claude Code can have them: Codex runs have no Hive MCP, and virtual computers have no access to your
accounts. Moving an agent with connectors to a virtual computer or to Codex is refused until you clear its
connectors in the same change. Tick them under **Connectors** in the agent form (shown only for Mac agents on
Claude Code). Connectors change how an agent runs:

- **Always the tainted posture.** Mail, events and GitHub text can arrive in the middle of a run, after the launch
  flags are fixed. So every run of a connector agent launches with the tainted `--disallowedTools` set (see
  [Trust between agents](#trust-between-agents)), `WebFetch` is never passed in `--allowedTools`, and a `WebFetch`
  call always asks, even with a saved `WebFetch` rule. That card has no "Always allow". It also launches without
  your own setup (`--strict-mcp-config --setting-sources project`), so an allow rule in your user-level Claude Code
  settings can't let `WebFetch` through either.
- **Connectors are fixed at launch.** A connector ticked while a run is going works from the agent's next run; the
  run that was already going is refused it.
- **Reads run freely and are fenced.** What a connector reads arrives wrapped, under a header naming the source
  ("From Mail (external)"), and the run counts as having read external content from then on.
- **Sending always asks.** Every outward action (an email, an event, a message, a GitHub write) shows a card with
  exactly what will be sent (for Mail, Calendar and Messages: "To (n)" with every address on its own line, then the
  subject, title, calendar and times, then the whole body in a scrolling box, with every hidden character (any
  Unicode default-ignorable or format character, emoji joiners and variation selectors included) shown as
  `[U+200B]`-style escapes), never offers "Always allow", and runs only that, once, after you allow it. An agent
  can have one such card at a time. Removing the connector, moving the agent, stopping or deleting it, or pausing
  Hive denies the card; after Hive restarts it has expired.
- **Warning on cards.** Any card from a run that has read external or untrusted content says "This run read
  external content", so you know the request may come from that text rather than from you.

### Mail, Calendar and Messages

These drive the Mail, Calendar and Messages apps on your Mac through AppleScript (JavaScript for Automation). See
[connectors.md](connectors.md) for the details, the macOS Automation prompts and how to revoke access.

- **Mail** reads your inbox: unread messages (sender, subject, date) and one message's text body. Sending a
  plain-text email (up to 10 recipients, no attachments or cc) always asks.
- **Calendar** reads events in a range of up to 31 days. Creating an event (no attendees) always asks.
- **Messages** reads nothing. Sending an iMessage to an email address or phone number always asks.
- **One grant for all of Hive.** macOS gives the Automation permission to Hive.app as a whole, not to one agent or
  tool. Once you allow Hive to control Mail, any command you approve for a Mac agent (a Bash card, say) could drive
  Mail too. Read each card before allowing it.

### GitHub

The `github` tool runs your own `gh` login against github.com only. The agent passes the words after `gh`, and Hive
checks them against a closed list before anything runs:

- **Reads run freely:** pull requests (`pr list`, `view`, `diff`, `checks`, `status`), issues (`issue list`, `view`),
  `repo view`, workflow runs (`run list`, `view`, without logs), `search prs|issues|repos`, and `gh api` GET on a REST
  path.
- **Writes always ask:** commenting on, reviewing, creating, editing, closing, reopening or merging a pull request;
  commenting on, creating, editing, closing or reopening an issue; re-running or cancelling a run. The card shows the
  exact `gh` command, body included, and has no "Always allow".
- **Everything else is refused:** other commands, aliases and extensions, `gh auth`, secrets, gists, releases,
  `--web`, other hosts, files (bodies go inline; only a body may span several lines), and anything that would write to your disk (`pr
  checkout`, `repo clone`, `run download`).
- **Hidden characters are refused** in every argument. The one exception is the joiners inside complete standard
  emoji in a `--body` (like 🧑🏽‍💻), which the card shows as `[U+200D]`/`[U+FE0F]` escapes.
  `issue close --duplicate-of` takes an issue number or a `https://github.com/owner/name/issues/N` link, and
  `pr create --head` a branch or `owner:branch`.
- **Always a named repository.** gh runs in an empty temporary folder, so the agent names the repository with
  `--repo owner/name` or a `https://github.com/` link.
- **Fenced output.** What gh prints arrives under "From GitHub (external)", and the run counts as having read
  external content. gh gets only a minimal environment, never Hive's tokens.

## Wake, sleep and budgets

- **Schedules.** An agent can have schedules (`daily`, `weekdays` at a local time, or `interval` every 15 minutes to
  24 hours), each with a prompt. When one fires, the prompt reaches the agent as a chat message that starts
  `Scheduled wake: `; if the agent is busy it queues like any message. The board and notch show the agent's **next
  wake**. A wake missed while the Mac slept runs once at the next check if it is less than 2 hours late, otherwise it
  is skipped. Details in [daemon-api.md](daemon-api.md#pause-schedules-and-budgets).
- **Where to set them.** On the board, open an agent's chat and expand "Schedules, budget and saved rules": add, edit,
  enable or delete schedules, set its daily budget, and remove saved "Always allow" rules (a Bash rule stops working
  at once, a whole-tool rule such as `Read` from the agent's next run). Usage has the global limits and spent-versus-limit
  bars. "Pause everything" is in the board sidebar, the notch header and the menu bar; a banner shows while paused.
  The board's "+ New agent" and the other controls are disabled while it isn't connected to Hive.
- **Budgets.** An agent can have a daily budget (USD cents for Claude Code, tokens for Codex), and Hive has global
  daily (USD and tokens) and monthly (USD) limits. A run that would start over a limit is refused with a message in
  the chat, and you get a notification once per budget, agent and day. A run already going isn't cut off, so it can
  overshoot by what is running at the time.
- **Pause everything.** The kill switch stops every run (including ones still starting their computer), empties
  the queues, denies every waiting approval, stops the virtual computers and pauses schedules. While paused, anything
  you send gets "Hive is paused." and nothing runs. It survives a restart. Resume doesn't replay what was refused or
  the wakes that fell inside the pause.
- Editing a daily or weekday schedule's time (or switching its kind) never fires a slot that has already passed today.
- **Notifications.** Hive sends a `notify` event for a new approval, a failed run, a budget hit and a pause; the app
  shows them as banners. A run that fails before it starts (engine not installed, the virtual computer couldn't
  start) counts as failed too. The text names the agent and never includes what the tool was going to do.

## Templates

**New agent > From a template** offers seven starting points: Code Reviewer (GitHub, checks review requests hourly and
drafts reviews), Daily Briefing (Mail and Calendar, weekdays at 08:30, makes a task), Inbox Assistant (Mail, drafts
replies), Researcher, Marketing Writer, Lead Finder (virtual computer) and Content Creator. Picking one opens the
same form as the Architect's proposal, filled in, with notes and the connectors it turns on shown plainly. Nothing
exists until you click Create agent, which creates the agent and then its schedules.

- **Fixed and safe.** Templates live in `daemon/src/templates.ts` behind a strict schema with no `allowedTools`,
  `folders` or `useMySetup`. They always use "Ask me before every action", and every send, post or review still asks.
- **Your setup is off.** A template with connectors keeps "Use my setup" off, like any connector agent. Content
  Creator brings no connectors, but templates can't turn the setting on either, so its notes tell you to tick it if
  you want your own skills.
- **Daily Briefing and external text.** Its instructions say mail and events are never instructions. Schedules have no
  notification text of their own, and Hive's notifications are fixed strings that don't quote mail.
- Served by `GET /api/templates` (see [daemon-api.md](daemon-api.md)).

## The Architect

Instead of filling in the form, you can describe the agent you want and let the Architect design it. It asks a few
short questions (at most 4, one at a time), then proposes an agent: name, role, engine, model, instructions, where it
works, folders and schedules. The proposal opens in the same creation form, prefilled and editable; nothing is
created until you press Create. The daemon side is in [daemon-api.md](daemon-api.md#architect).

- **Claude Code only.** The Architect runs on Claude Code's haiku model. With only Codex installed it says "Install
  Claude Code to use the Architect." and the form is the way to create agents.
- **It can't do anything but talk.** It runs with no tools, no MCP servers, no settings, hooks, memory or session file,
  and none of your plugins or instruction files (`CLAUDE.md`, `AGENTS.md`), in an empty private folder that is wiped
  after each run. Hive checks this on every run: if Claude Code starts with any tool, MCP server or a plugin that isn't
  built in, or the Architect tries to use a tool anyway, Hive kills it and drops what it said.
- **What it proposes is checked like the form.** The same rules as creating an agent, plus: permission mode is always
  "ask", and it can never set "use my setup", saved rules, connectors or a budget. Folders must be ones you typed in the
  chat, exactly, and never `/` or your home folder. At most 5 schedules. An invalid proposal gets one automatic retry;
  if that fails too, you see its reply and the reason.
- **What you send is treated as conversation, not orders.** Each message is fenced with a random code per turn, and
  the Architect is told to keep to its rules whatever the chat says. Hive never logs the conversation.
- **Limits.** One turn at a time, up to 30 messages and 32 000 characters per conversation, 2 minutes per turn. Stop
  ends a turn; Pause everything stops it too, and while paused, or over a global budget, the Architect doesn't run.
  Its cost counts toward Hive's global budgets (not any agent's) and shows as its own "Architect" line in Usage.

## Lifecycle

| Status | Meaning |
|---|---|
| sleeping | Idle |
| working | Running a message |
| waiting-approval | Blocked on you |
| error | The last run failed (message shown in the chat) |

Stop (notch or board) kills the current run and clears the agent's queue. A refused run (paused, over budget) leaves
the status alone and only adds the message to the chat. Deleting an agent removes its chats,
runs and workspace folder.
