import type { Agent, TaskStatus } from "../api.ts";
import { isTaskStatus, STATUS_TITLES, TASK_STATUSES } from "../tasks.ts";

export function StatusSelect({ value, onChange }: { value: TaskStatus; onChange: (status: TaskStatus) => void }) {
  return (
    <label>
      Status
      <select value={value} onChange={(event) => isTaskStatus(event.target.value) && onChange(event.target.value)}>
        {TASK_STATUSES.map((status) => (
          <option key={status} value={status}>{STATUS_TITLES[status]}</option>
        ))}
      </select>
    </label>
  );
}

export function AssigneeSelect({ agents, value, onChange }: { agents: readonly Agent[]; value: string | null; onChange: (id: string | null) => void }) {
  return (
    <label>
      Assignee
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">Unassigned</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}{agent.computer === "virtual" ? " (virtual)" : ""}</option>
        ))}
      </select>
    </label>
  );
}
