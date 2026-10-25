import type { Agent } from "../api.ts";
import { CONNECTOR_NAMES } from "../connectors.ts";

type Connector = Agent["connectors"][number];

const CHOICES: readonly { connector: Connector; title: string; note: string }[] = [
  {
    connector: "github",
    title: CONNECTOR_NAMES.github,
    note: "Reads pull requests, issues, runs and search on github.com without asking. Every write (a comment, review, merge or new issue) asks you, every time.",
  },
  {
    connector: "mail",
    title: CONNECTOR_NAMES.mail,
    note: "Reads unread inbox messages (sender, subject, date, body) in the Mail app. Sending an email always asks you first, every time.",
  },
  {
    connector: "calendar",
    title: CONNECTOR_NAMES.calendar,
    note: "Reads events (up to 31 days at a time) from the Calendar app. Creating an event always asks you first, every time.",
  },
  {
    connector: "messages",
    title: CONNECTOR_NAMES.messages,
    note: "Reads nothing. Sending an iMessage always asks you first, every time.",
  },
];

interface Props {
  connectors: readonly Connector[];
  onChange: (connectors: Connector[]) => void;
}

export function ConnectorsField({ connectors, onChange }: Props) {
  const toggle = (connector: Connector, on: boolean) => {
    const others = connectors.filter((existing) => existing !== connector);
    onChange(on ? [...others, connector] : others);
  };
  return (
    <fieldset>
      <legend>Connectors</legend>
      {CHOICES.map((choice) => (
        <label key={choice.connector} className="check connector">
          <input type="checkbox" checked={connectors.includes(choice.connector)} onChange={(event) => toggle(choice.connector, event.target.checked)} />
          <span>
            <strong>{choice.title}</strong>
            <span className="hint">{choice.note}</span>
          </span>
        </label>
      ))}
      <span className="hint">macOS grants Automation to Hive as a whole, so once you allow Mail, Calendar or Messages, a command you approve for any agent could use them too.</span>
      <span className="hint">With any connector, the agent always runs with the stricter posture for external content: saved WebFetch rules stop applying, so every web fetch asks, and it runs without your own Claude Code setup.</span>
    </fieldset>
  );
}
