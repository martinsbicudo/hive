import type { ApprovalDisplay, GhDisplay, MailDisplay } from "../schemasState.ts";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function GhCard({ agentName, display }: { agentName: string; display: GhDisplay }) {
  return (
    <div className="outward">
      <p className="outward-action"><strong>{agentName}</strong> wants to run <code>{display.command}</code></p>
      {display.targets.length > 0 && (
        <dl className="outward-fields">
          {display.targets.map((entry, index) => (
            <div key={index}>
              <dt>{entry.label}</dt>
              <dd><code>{entry.value}</code></dd>
            </div>
          ))}
        </dl>
      )}
      {display.flags.length > 0 && (
        <dl className="outward-fields">
          {display.flags.map((entry, index) => (
            <div key={index}>
              <dt><code>{entry.label}</code></dt>
              <dd>{entry.value === null ? "set (takes no value)" : <code>{entry.value}</code>}</dd>
            </div>
          ))}
        </dl>
      )}
      {display.body !== null && (
        <div className="outward-to">
          <span className="outward-label">
            <code>{display.body.label}</code> · {plural(display.body.lines, "line")} · {plural(display.body.chars, "character")}
          </span>
          <pre className="outward-body" tabIndex={0} aria-label="Full text">{display.body.text}</pre>
        </div>
      )}
    </div>
  );
}

function MailCard({ agentName, display }: { agentName: string; display: MailDisplay }) {
  return (
    <div className="outward">
      <p className="outward-action"><strong>{agentName}</strong> wants to: {display.action}</p>
      {display.to.length > 0 && (
        <div className="outward-to">
          <span className="outward-label">To ({display.to.length})</span>
          <ul>{display.to.map((address, index) => <li key={index}><code>{address}</code></li>)}</ul>
        </div>
      )}
      {display.fields.length > 0 && (
        <dl className="outward-fields">
          {display.fields.map((entry, index) => (
            <div key={index}>
              <dt>{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {display.body !== null && <pre className="outward-body" tabIndex={0} aria-label="Full text">{display.body}</pre>}
    </div>
  );
}

export function OutwardCard({ agentName, display }: { agentName: string; display: ApprovalDisplay }) {
  return "kind" in display ? <GhCard agentName={agentName} display={display} /> : <MailCard agentName={agentName} display={display} />;
}
