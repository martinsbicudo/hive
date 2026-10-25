import type { Store } from "./db.ts";
import { HttpError } from "./httpError.ts";
import { buildPatch, buildSchedule } from "./scheduleInput.ts";
import type { Schedule } from "./types.ts";

export class ScheduleService {
  private readonly store: Store;
  private readonly clock: () => Date;
  private readonly changed: () => void;

  constructor(store: Store, clock: () => Date, changed: () => void) {
    this.store = store;
    this.clock = clock;
    this.changed = changed;
  }

  list(agentId: string): Schedule[] {
    this.agent(agentId);
    return this.store.schedules.listFor(agentId);
  }

  add(agentId: string, raw: unknown): Schedule {
    this.agent(agentId);
    const schedule = buildSchedule(raw, agentId, this.clock().toISOString());
    this.store.schedules.insert(schedule);
    this.changed();
    return schedule;
  }

  update(agentId: string, id: string, raw: unknown): Schedule {
    const current = this.owned(agentId, id);
    this.store.schedules.update(id, buildPatch(raw, current, this.clock().toISOString()));
    this.changed();
    return this.owned(agentId, id);
  }

  remove(agentId: string, id: string): void {
    this.owned(agentId, id);
    this.store.schedules.delete(id);
    this.changed();
  }

  private agent(agentId: string): void {
    if (!this.store.getAgent(agentId)) throw new HttpError(404, "agent not found");
  }

  private owned(agentId: string, id: string): Schedule {
    this.agent(agentId);
    const schedule = this.store.schedules.get(id);
    if (schedule?.agentId !== agentId) throw new HttpError(404, "schedule not found");
    return schedule;
  }
}
