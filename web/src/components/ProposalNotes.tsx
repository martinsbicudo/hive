import type { Agent, ProposedSchedule } from "../api.ts";
import { connectorNames } from "../connectors.ts";
import { isShortInterval } from "../proposal.ts";
import { describeSchedule } from "../wake.ts";

interface Props {
  origin: "architect" | "template";
  notes: readonly string[];
  connectors: Agent["connectors"];
  folders: readonly string[];
  useMySetup: boolean;
  schedules: readonly ProposedSchedule[];
  onRemoveSchedule: (index: number) => void;
}

export function ProposalNotes({ origin, notes, connectors, folders, useMySetup, schedules, onRemoveSchedule }: Props) {
  return (
    <>
      {notes.length > 0 && <ul className="notes">{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      {origin === "template" && connectors.length > 0 && (
        <p className="warning">This template turns on {connectors.length > 1 ? "these connectors" : "this connector"}: {connectorNames(connectors)}. Anything the agent reads from there is treated as external content, and anything it sends asks you first. Untick under Connectors to turn them off.</p>
      )}
      {useMySetup && origin === "architect" && <p className="warning">Your setup brings in your skills, plugins and MCP servers. The Architect didn't ask for that, so check it is what you want.</p>}
      {folders.length > 0 && (
        <div className="warning">
          <p>The agent will be able to read and change files in:</p>
          <ul>{folders.map((folder) => <li key={folder}><code>{folder}</code></li>)}</ul>
        </div>
      )}
      <section className="schedules" aria-label="Schedules">
        <h3>Schedules</h3>
        {schedules.length === 0 && <p className="muted">No schedules. The agent only works when you message it or assign a task.</p>}
        {schedules.length > 0 && <p className="warning">These run without you. Each wake starts the agent with the prompt below, whether or not you are around.</p>}
        <ul className="schedule-list">
          {schedules.map((schedule, index) => (
            <li key={`${index}-${schedule.kind}-${schedule.at}-${schedule.everyMinutes}-${schedule.prompt}`} className="schedule">
              <div className="schedule-text">
                <strong>{describeSchedule(schedule.kind, schedule.at, schedule.everyMinutes)}</strong>
                {isShortInterval(schedule) && <span className="error">Wakes more than once an hour.</span>}
                <span className="muted full">{schedule.prompt}</span>
              </div>
              <button type="button" className="ghost danger" onClick={() => onRemoveSchedule(index)}>Remove</button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
