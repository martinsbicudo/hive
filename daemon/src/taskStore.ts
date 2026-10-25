import type { DatabaseSync } from "node:sqlite";
import { columnsOf, flag, number, oneOf, optionalText, text, type Row } from "./sqlRows.ts";
import { TASK_GATES, TASK_STATUSES, type Task, type TaskGate, type TaskEvent, type TaskEventKind, type TaskStatus } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, assignee_id TEXT,
  created_by TEXT NOT NULL, title_untrusted INTEGER NOT NULL DEFAULT 0, description_untrusted INTEGER NOT NULL DEFAULT 0,
  title_mac_only INTEGER NOT NULL DEFAULT 0, description_mac_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  untrusted INTEGER NOT NULL DEFAULT 0, author_mac INTEGER NOT NULL DEFAULT 0, gate TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);
CREATE TABLE IF NOT EXISTS task_sessions (
  task_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (task_id, agent_id)
);
CREATE TABLE IF NOT EXISTS tainted_sessions (session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL);
`;

const EVENT_KINDS: readonly TaskEventKind[] = ["comment", "status", "assign", "handoff"];

export type NewTaskEvent = Omit<TaskEvent, "id" | "createdAt">;

export interface TaskPatch {
  title?: string;
  titleUntrusted?: boolean;
  description?: string;
  descriptionUntrusted?: boolean;
  titleMacOnly?: boolean;
  descriptionMacOnly?: boolean;
  status?: TaskStatus;
  assigneeId?: string | null;
}

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    if (!columnsOf(db, "task_events").includes("gate")) this.db.exec("ALTER TABLE task_events ADD COLUMN gate TEXT");
    const taskColumns = columnsOf(db, "tasks");
    for (const column of ["title_mac_only", "description_mac_only"]) {
      if (!taskColumns.includes(column)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
  }

  insertTask(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, assignee_id, created_by, title_untrusted, description_untrusted,
         title_mac_only, description_mac_only, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        task.id, task.title, task.description, task.status, task.assigneeId, task.createdBy, task.titleUntrusted ? 1 : 0,
        task.descriptionUntrusted ? 1 : 0, task.titleMacOnly ? 1 : 0, task.descriptionMacOnly ? 1 : 0, task.createdAt, task.updatedAt,
      );
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? toTask(row) : null;
  }

  listTasks(): Task[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY created_at, id").all().map(toTask);
  }

  tasksAssignedTo(agentId: string): Task[] {
    return this.db.prepare("SELECT * FROM tasks WHERE assignee_id = ? ORDER BY created_at, id").all(agentId).map(toTask);
  }

  updateTask(id: string, patch: TaskPatch, now: string): void {
    const columns: [string, string | number | null][] = [];
    if (patch.title !== undefined) columns.push(["title", patch.title]);
    if (patch.titleUntrusted !== undefined) columns.push(["title_untrusted", patch.titleUntrusted ? 1 : 0]);
    if (patch.description !== undefined) columns.push(["description", patch.description]);
    if (patch.descriptionUntrusted !== undefined) columns.push(["description_untrusted", patch.descriptionUntrusted ? 1 : 0]);
    if (patch.titleMacOnly !== undefined) columns.push(["title_mac_only", patch.titleMacOnly ? 1 : 0]);
    if (patch.descriptionMacOnly !== undefined) columns.push(["description_mac_only", patch.descriptionMacOnly ? 1 : 0]);
    if (patch.status !== undefined) columns.push(["status", patch.status]);
    if (patch.assigneeId !== undefined) columns.push(["assignee_id", patch.assigneeId]);
    if (columns.length === 0) return;
    const assignments = columns.map(([column]) => `${column} = ?`).join(", ");
    this.db.prepare(`UPDATE tasks SET ${assignments}, updated_at = ? WHERE id = ?`).run(...columns.map(([, value]) => value), now, id);
  }

  addEvent(event: NewTaskEvent, now: string): TaskEvent {
    const result = this.db
      .prepare("INSERT INTO task_events (task_id, author, kind, text, untrusted, author_mac, gate, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(event.taskId, event.author, event.kind, event.text, event.untrusted ? 1 : 0, event.authorMac ? 1 : 0, event.gate, now);
    return { ...event, id: Number(result.lastInsertRowid), createdAt: now };
  }

  listEvents(taskId: string): TaskEvent[] {
    return this.db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id").all(taskId).map(toEvent);
  }

  session(taskId: string, agentId: string): string | null {
    const row = this.db.prepare("SELECT session_id FROM task_sessions WHERE task_id = ? AND agent_id = ?").get(taskId, agentId);
    return row ? text(row, "session_id") : null;
  }

  setSession(taskId: string, agentId: string, sessionId: string): void {
    this.db
      .prepare("INSERT INTO task_sessions (task_id, agent_id, session_id) VALUES (?,?,?) ON CONFLICT(task_id, agent_id) DO UPDATE SET session_id = excluded.session_id")
      .run(taskId, agentId, sessionId);
  }

  deleteSession(taskId: string, agentId: string): void {
    this.db.prepare("DELETE FROM task_sessions WHERE task_id = ? AND agent_id = ?").run(taskId, agentId);
  }

  sessionsOf(agentId: string): { taskId: string; sessionId: string }[] {
    return this.db
      .prepare("SELECT task_id, session_id FROM task_sessions WHERE agent_id = ?")
      .all(agentId)
      .map((row) => ({ taskId: text(row, "task_id"), sessionId: text(row, "session_id") }));
  }

  deleteSessionsOf(agentId: string): void {
    this.db.prepare("DELETE FROM task_sessions WHERE agent_id = ?").run(agentId);
  }

  taintSession(agentId: string, sessionId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO tainted_sessions (session_id, agent_id) VALUES (?,?)").run(sessionId, agentId);
  }

  isSessionTainted(sessionId: string | null): boolean {
    if (sessionId === null) return false;
    return this.db.prepare("SELECT 1 FROM tainted_sessions WHERE session_id = ?").get(sessionId) !== undefined;
  }

  forgetAgent(agentId: string): void {
    this.deleteSessionsOf(agentId);
    this.db.prepare("DELETE FROM tainted_sessions WHERE agent_id = ?").run(agentId);
  }
}

function toTask(row: Row): Task {
  return {
    id: text(row, "id"),
    title: text(row, "title"),
    description: text(row, "description"),
    status: oneOf<TaskStatus>(text(row, "status"), TASK_STATUSES, "backlog"),
    assigneeId: optionalText(row, "assignee_id"),
    createdBy: text(row, "created_by"),
    titleUntrusted: flag(row, "title_untrusted"),
    descriptionUntrusted: flag(row, "description_untrusted"),
    titleMacOnly: flag(row, "title_mac_only"),
    descriptionMacOnly: flag(row, "description_mac_only"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function toEvent(row: Row): TaskEvent {
  return {
    id: number(row, "id"),
    taskId: text(row, "task_id"),
    author: text(row, "author"),
    kind: oneOf(text(row, "kind"), EVENT_KINDS, "comment"),
    text: text(row, "text"),
    untrusted: flag(row, "untrusted"),
    authorMac: flag(row, "author_mac"),
    gate: gateOf(optionalText(row, "gate")),
    createdAt: text(row, "created_at"),
  };
}

function gateOf(value: string | null): TaskGate | null {
  return TASK_GATES.find((gate) => gate === value) ?? null;
}
