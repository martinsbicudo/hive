import { useState } from "react";
import { type Agent, type HubState } from "../api.ts";
import { groupByStatus, STATUS_TITLES, TASK_STATUSES, waitingTaskIds } from "../tasks.ts";
import { useTasks } from "../useTasks.ts";
import { NewTaskDialog } from "./NewTaskDialog.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { TaskDrawer } from "./TaskDrawer.tsx";

interface Props {
  state: HubState;
  tick: number;
  openTaskId: string | null;
  onOpenTask: (id: string | null) => void;
}

export function Board({ state, tick, openTaskId, onOpenTask }: Props) {
  const { tasks, error, move, setError } = useTasks(tick);
  const [creating, setCreating] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<string | null>(null);

  const groups = groupByStatus(tasks);
  const agents = new Map<string, Agent>(state.agents.map((agent) => [agent.id, agent]));
  const waiting = waitingTaskIds(state.approvals);

  return (
    <section className="board">
      <header className="board-head">
        <h2>Board</h2>
        <button className="primary" onClick={() => setCreating(true)}>New task</button>
      </header>
      {error && <p className="error pad" role="alert">{error}</p>}
      <div className="columns">
        {TASK_STATUSES.map((status) => (
          <div
            key={status}
            className={`column ${overStatus === status ? "over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOverStatus(status);
            }}
            onDragLeave={() => setOverStatus((current) => (current === status ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              const dropped = tasks.find((task) => task.id === dragId);
              setOverStatus(null);
              setDragId(null);
              if (dropped && dropped.status !== status) void move(dropped.id, status);
            }}
          >
            <h3 className="column-head">
              <span>{STATUS_TITLES[status]}</span>
              <span className="count">{groups[status].length}</span>
            </h3>
            <div className="column-body">
              {groups[status].map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  assignee={task.assigneeId ? agents.get(task.assigneeId) : undefined}
                  waiting={waiting.has(task.id)}
                  dragging={dragId === task.id}
                  onOpen={() => onOpenTask(task.id)}
                  onDragStart={() => setDragId(task.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverStatus(null);
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {tasks.length === 0 && <p className="muted pad">No tasks yet. Create one and assign it to an agent, or leave it in the backlog.</p>}
      {creating && (
        <NewTaskDialog
          agents={state.agents}
          onClose={() => setCreating(false)}
          onCreated={(task) => {
            setCreating(false);
            onOpenTask(task.id);
            setError(null);
          }}
        />
      )}
      {openTaskId && <TaskDrawer taskId={openTaskId} agents={state.agents} tick={tick} onClose={() => onOpenTask(null)} />}
    </section>
  );
}
