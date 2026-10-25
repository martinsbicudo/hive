import { useState, type FormEvent } from "react";
import { api, type Agent, type Task, type TaskStatus } from "../api.ts";
import { messageOf } from "../useTasks.ts";
import { AssigneeSelect, StatusSelect } from "./TaskFields.tsx";

interface Props {
  agents: readonly Agent[];
  onClose: () => void;
  onCreated: (task: Task) => void;
}

export function NewTaskDialog({ agents, onClose, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [status, setStatus] = useState<TaskStatus>("todo");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createTask({ title: title.trim(), description, status, assigneeId }));
    } catch (caught) {
      setError(messageOf(caught, "Couldn't create the task."));
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="dialog" onSubmit={(event) => void submit(event)} aria-label="New task">
        <h2>New task</h2>
        <label>
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus required maxLength={200} />
        </label>
        <label>
          Description
          <textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="grid two">
          <AssigneeSelect agents={agents} value={assigneeId} onChange={setAssigneeId} />
          <StatusSelect value={status} onChange={setStatus} />
        </div>
        {assigneeId && <p className="hint">The assignee starts working on it right away.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-foot">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !title.trim()}>Create task</button>
        </div>
      </form>
    </div>
  );
}
