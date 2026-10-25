import { avatarUrl, type Agent, type TaskEvent } from "../api.ts";
import { authorOf, formatWhen, untrustedLabel } from "../tasks.ts";

const KIND_LABELS: Record<TaskEvent["kind"], string> = { comment: "", status: "changed status", assign: "changed assignee", handoff: "handed off" };

function EventItem({ event, agents }: { event: TaskEvent; agents: readonly Agent[] }) {
  const author = authorOf(event, agents);
  const flag = untrustedLabel(event, author);
  const kind = KIND_LABELS[event.kind];
  return (
    <li className={`event ${event.kind} ${event.author === "system" ? "system" : ""} ${flag ? "untrusted" : ""}`}>
      {author.agent ? <img className="avatar xs" src={avatarUrl(author.agent)} alt="" /> : <span className="avatar xs plain" aria-hidden="true">{author.name.slice(0, 1)}</span>}
      <div className="event-body">
        <div className="event-head">
          <strong>{author.name}</strong>
          {kind && <span className="muted">{kind}</span>}
          <time className="muted" dateTime={event.createdAt}>{formatWhen(event.createdAt)}</time>
        </div>
        {flag && <div className="flag">{flag}</div>}
        <p className="event-text">{event.text}</p>
      </div>
    </li>
  );
}

export function Thread({ events, agents }: { events: readonly TaskEvent[]; agents: readonly Agent[] }) {
  if (events.length === 0) return <p className="muted">Nothing yet. Comments, status changes and hand-offs show up here.</p>;
  return (
    <ol className="thread">
      {events.map((event) => (
        <EventItem key={event.id} event={event} agents={agents} />
      ))}
    </ol>
  );
}
