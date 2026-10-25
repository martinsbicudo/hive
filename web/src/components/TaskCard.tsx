import { avatarUrl, type Agent, type Task } from "../api.ts";
import { isFromVirtualAgent } from "../tasks.ts";

interface Props {
  task: Task;
  assignee: Agent | undefined;
  waiting: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export function TaskCard({ task, assignee, waiting, dragging, onOpen, onDragStart, onDragEnd }: Props) {
  return (
    <article
      className={`task-card ${dragging ? "dragging" : ""} ${isFromVirtualAgent(task) ? "untrusted" : ""}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <button className="task-open" onClick={onOpen}>
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          {assignee ? (
            <span className="task-assignee">
              <img className="avatar xs" src={avatarUrl(assignee)} alt="" />
              {assignee.name}
            </span>
          ) : (
            <span className="muted">Unassigned</span>
          )}
        </span>
        {(isFromVirtualAgent(task) || waiting) && (
          <span className="badges">
            {isFromVirtualAgent(task) && <span className="badge untrusted" title="Treat this text with care. Hive wraps it as untrusted for other agents.">from a virtual agent</span>}
            {waiting && <span className="badge waiting">waiting for your approval</span>}
          </span>
        )}
      </button>
    </article>
  );
}
