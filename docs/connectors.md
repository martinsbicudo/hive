# Connectors: Mail, Calendar and Messages

Check without real accounts: `make e2e-step6` creates agents from templates and drives the connector routes with a fake
`gh` and `osascript` (nothing real runs, no cost).

A Mac agent on Claude Code can be given the `mail`, `calendar` and `messages` connectors (and `github`, covered in
[agents.md](agents.md#github)). Tick them under **Connectors** in the agent form. Codex agents and agents on a
virtual computer can't have them.

## What each tool does

| Tool | Reads or sends | Asks you? |
|---|---|---|
| `mail_unread` | Reads up to 20 unread messages in Mail's inbox: id, date, sender, subject | No |
| `mail_read` | Reads one inbox message by id: sender, recipients, date, subject, plain-text body (up to 20 kB) | No |
| `mail_send` | Sends a plain-text email from Mail's default account to 1–10 addresses. No attachments, cc or bcc | Every time |
| `calendar_events` | Reads events overlapping a range of up to 31 days, from every calendar: time, title, calendar, location, notes | No |
| `calendar_create` | Creates one event in a named calendar, or the first one you can write to. No attendees or invitations | Every time |
| `messages_send` | Sends one iMessage (up to 2000 characters) to an email address or phone number like `+15551234567` | Every time |

Hive can't read your iMessages: that needs Full Disk Access, which Hive doesn't ask for.

What an agent reads arrives fenced as external content ("From Mail (external)", "From Calendar (external)"), and the
rest of that run counts as having read external content: its approval cards say "This run read external content".
An agent with any connector always runs with the stricter posture, so saved WebFetch rules stop applying, and it
launches without your own Claude Code setup even if "Use my setup" was on (the form shows it off while a connector is
ticked). A connector ticked while a run is going works from the agent's next run.

## The send card

Every email, event and iMessage waits for you on a card in the board and in the notch. The card shows:

1. "To (n)" with every address on its own line;
2. the subject, or the event's title, calendar, start and end;
3. the whole body (or the event's notes) in a scrolling box, never cut;
4. hidden characters (zero-width spaces, right-to-left overrides, variation selectors, tag characters, emoji joiners,
   any other Unicode default-ignorable or format character, stray control characters) as visible escapes like
   `[U+200B]` or `[U+E0100]`. Subjects, titles and calendar names holding any of them are refused outright. Blank
   look-alikes are escaped too: in the subject, title and addresses every Unicode space other than the plain space
   (no-break, en, em, thin, ideographic and so on), the braille blank U+2800 and U+1D159; in the body the same, except
   the ideographic space U+3000, which CJK text uses as ordinary spacing;
5. "This run read external content" when it applies.

What you see is exactly what runs, once, and only after you click **Allow**. There is no "Always allow". An agent
can have one send waiting at a time. Removing the connector, moving the agent, stopping or deleting it, or pausing
Hive denies the card; after Hive restarts it has expired.

A `github` write gets its own card: the `gh` command, then the repository and the pull request, issue or run, each
labelled, then one row per flag with its value on its own (no shell quoting), then the body last with its line and
character counts. It escapes hidden characters and blanks the same way. A body may hold emoji joined with U+200D or
U+FE0F when they form a standard emoji; the card still shows those joiners as `[U+200D]` and `[U+FE0F]`.

## macOS Automation prompts

Hive drives the apps through AppleScript (JavaScript for Automation): fixed scripts in `daemon/connectors/`, run with
`/usr/bin/osascript`. The first time a connector touches Mail, Calendar or Messages, macOS asks whether **Hive** may
control that app. The prompt appears once per app. If you click **Don't Allow**, the tool answers that macOS hasn't
let Hive control the app.

To change your answer later, or to revoke access: **System Settings > Privacy & Security > Automation**, open
**Hive**, and switch Mail, Calendar or Messages off (or on). Turning a connector off in the agent form stops that
agent from using it, but leaves the macOS permission in place for Hive.

## The residual: one grant for all of Hive

macOS grants Automation to Hive.app as a whole. The daemon runs as a child of Hive.app, so macOS checks Hive's grant
for the daemon and for everything it starts, including an agent's Bash commands. Once you allow Hive to control
Mail, any command you approve for a Mac agent could drive Mail too, for example
`osascript -l JavaScript -e 'Application("Mail").inbox.messages.length'`.

That command still shows on its own Bash approval card, so it can't happen without you allowing it, but the card
won't say "Mail". Read Bash cards before allowing them, especially ones that mention `osascript`. A later release may
move the grant to a small signed helper app that only the connectors use.

### TCC probe

Status: **run on 2026-10-23** with the installed app.

- `mail_unread` returned the unread inbox after the Automation prompt for Mail was allowed, and one `mail_send` to
  the user's own address went out after its card was allowed. `calendar_events` hasn't been run yet.
- Codex run: `osascript -l JavaScript -e 'Application("Mail").inbox.messages.length'` ran without a card (Codex has
  no per-action approvals) and failed with `Application can't be found. (-2700)`. Codex's workspace-write sandbox
  blocks Apple Events, so Hive's Automation grant doesn't reach Codex. The stop condition did not occur.
- Bash command of a Mac Claude Code agent, allowed on its card: not run. It's the known residual above, so it would
  work, and it only runs if you allow its card.
