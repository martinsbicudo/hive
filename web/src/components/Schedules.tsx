import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Agent, type Schedule, type ScheduleInput } from "../api.ts";
import { describeSchedule } from "../wake.ts";
import { ScheduleForm } from "./ScheduleForm.tsx";

export function Schedules({ agent, connected }: { agent: Agent; connected: boolean }) {
  const [items, setItems] = useState<Schedule[]>([]);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.schedules(agent.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't load the schedules.");
    }
  }, [agent.id]);

  useEffect(() => {
    void load();
  }, [load, agent.nextWake]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Hive didn't answer.");
    }
  };

  const save = async (input: ScheduleInput) => {
    if (editing === null) return;
    await (editing === "new" ? api.addSchedule(agent.id, input) : api.updateSchedule(agent.id, editing.id, input));
    setEditing(null);
    await load();
  };

  return (
    <section className="schedules" aria-label="Schedules">
      <div className="settings-head">
        <h3>Schedules</h3>
        <button className="ghost" disabled={!connected || editing !== null} onClick={() => setEditing("new")}>+ Add schedule</button>
      </div>
      <p className="hint">{agent.name} wakes up with your prompt at these times. Nothing runs while Hive is paused, and a wake missed while the Mac slept runs once if it is under 2 hours late.</p>
      {items.length === 0 && editing === null && <p className="muted">No schedules. {agent.name} only works when you message it or assign a task.</p>}
      <ul className="schedule-list">
        {items.map((item) => (
          <li key={item.id} className={`schedule ${item.enabled ? "" : "off"}`}>
            {editing !== "new" && editing?.id === item.id ? (
              <ScheduleForm schedule={item} onSave={save} onCancel={() => setEditing(null)} />
            ) : (
              <>
                <label className="check">
                  <input type="checkbox" checked={item.enabled} aria-label={`${describeSchedule(item.kind, item.at, item.everyMinutes)} enabled`} onChange={(event) => void act(() => api.updateSchedule(agent.id, item.id, { enabled: event.target.checked }))} />
                </label>
                <div className="schedule-text">
                  <strong>{describeSchedule(item.kind, item.at, item.everyMinutes)}</strong>
                  <span className="muted">{item.prompt}</span>
                </div>
                <div className="actions">
                  <button className="ghost" disabled={editing !== null} onClick={() => setEditing(item)}>Edit</button>
                  <button className="ghost danger" onClick={() => void act(() => api.deleteSchedule(agent.id, item.id))}>Delete</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {editing === "new" && <ScheduleForm schedule={null} onSave={save} onCancel={() => setEditing(null)} />}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
