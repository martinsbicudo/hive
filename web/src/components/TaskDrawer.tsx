import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, ApiError, type Agent, type Task, type TaskPatch } from "../api.ts";
import { changedDetails, isFromVirtualAgent, macOnlyFields, shownMacText } from "../tasks.ts";
import { messageOf, useThread } from "../useTasks.ts";
import { AssigneeSelect, StatusSelect } from "./TaskFields.tsx";
import { Thread } from "./Thread.tsx";

interface Props {
  taskId: string;
  agents: readonly Agent[];
  tick: number;
  onClose: () => void;
}

const MAC_TEXT_CHANGED = "A Mac agent changed this task's text after you saw it. Check the task and assign it again.";

function Details({ task, onSave }: { task: Task; onSave: (patch: TaskPatch) => Promise<void> }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description);
  }, [task.id, task.title, task.description]);
  const dirty = title.trim() !== task.title || description !== task.description;
  return (
    <>
      <label>
        Title
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
      </label>
      <label>
        Description
        <textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      {dirty && (
        <div className="row end">
          <button className="ghost" onClick={() => { setTitle(task.title); setDescription(task.description); }}>Revert</button>
          <button className="primary" disabled={!title.trim()} onClick={() => void onSave(changedDetails(task, title.trim(), description))}>Save changes</button>
        </div>
      )}
    </>
  );
}

export function TaskDrawer({ taskId, agents, tick, onClose }: Props) {
  const [saves, setSaves] = useState(0);
  const { data, error: loadError } = useThread(taskId, tick + saves);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const task = data?.task;
  const assignee = agents.find((agent) => agent.id === task?.assigneeId);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [data?.events.length]);

  const patch = async (change: TaskPatch) => {
    setError(null);
    try {
      await api.updateTask(taskId, change);
      setSaves((current) => current + 1);
    } catch (caught) {
      const changedOnMac = caught instanceof ApiError && caught.code === "mac-text";
      if (changedOnMac) setSaves((current) => current + 1);
      setError(changedOnMac ? MAC_TEXT_CHANGED : messageOf(caught, "Couldn't save."));
    }
  };

  const assign = (current: Task, assigneeId: string | null) => {
    const target = agents.find((agent) => agent.id === assigneeId);
    const fields = macOnlyFields(current);
    if (target?.computer !== "virtual" || fields.length === 0) {
      void patch({ assigneeId });
      return;
    }
    const question = `A Mac agent wrote this task's ${fields.join(" and ")}. Assigning it shows that text to virtual agents, starting with ${target.name}. Assign anyway?`;
    if (window.confirm(question)) void patch({ assigneeId, showMacText: shownMacText(current, fields) });
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const comment = text.trim();
    if (!comment) return;
    setText("");
    setError(null);
    try {
      await api.comment(taskId, comment);
    } catch (caught) {
      setText(comment);
      setError(messageOf(caught, "Couldn't send."));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="drawer-wrap" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer" aria-label="Task">
        <header className="drawer-head">
          <h2>Task</h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </header>
        {!task && <p className="muted pad">{loadError ?? "Loading…"}</p>}
        {task && (
          <>
            <div className="drawer-fields">
              {isFromVirtualAgent(task) && <p className="flag boxed">Some of this text came from a virtual agent. Other agents see it wrapped as untrusted.</p>}
              <Details task={task} onSave={patch} />
              <div className="grid two">
                <StatusSelect value={task.status} onChange={(status) => void patch({ status })} />
                <AssigneeSelect agents={agents} value={task.assigneeId} onChange={(assigneeId) => assign(task, assigneeId)} />
              </div>
            </div>
            <div className="drawer-thread">
              <h3>Thread</h3>
              <Thread events={data?.events ?? []} agents={agents} />
              <div ref={bottom} />
            </div>
            <form className="drawer-composer" onSubmit={(event) => void send(event)}>
              {error && <p className="error" role="alert">{error}</p>}
              <div className="composer-row">
                <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} placeholder="Add a comment…" aria-label="Comment" />
                <button type="submit" className="primary" disabled={!text.trim()}>Comment</button>
              </div>
              <p className="hint">
                {assignee ? `Commenting starts a run for ${assignee.name}, who reads the thread and replies here.` : "Nobody is assigned, so a comment only adds to the thread."}
              </p>
            </form>
          </>
        )}
      </aside>
    </div>
  );
}
