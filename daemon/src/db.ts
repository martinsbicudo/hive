import { DatabaseSync } from "node:sqlite";
import { storedDisplay } from "./outwardDisplay.ts";
import { ScheduleStore } from "./scheduleStore.ts";
import { SettingsStore } from "./settingsStore.ts";
import { ComputerStore } from "./computerStore.ts";
import { columnsOf, number, oneOf, optionalNumber, optionalText, text, type Row } from "./sqlRows.ts";
import { TaskStore } from "./taskStore.ts";
import { CONNECTORS, type Approval, type ApprovalStatus, type ComputerMode, type Connector, type Engine, type Message, type MessageRole, type PermissionMode, type Run, type StoredAgent } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL,
  instructions TEXT NOT NULL, avatar_style TEXT NOT NULL, avatar_seed TEXT NOT NULL,
  use_my_setup INTEGER NOT NULL, permission_mode TEXT NOT NULL, folders TEXT NOT NULL, allowed_tools TEXT NOT NULL,
  session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_agent ON messages(agent_id, id);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, started_at TEXT NOT NULL,
  ended_at TEXT, status TEXT NOT NULL, cost_usd REAL NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tool_name TEXT NOT NULL, input TEXT NOT NULL, summary TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, rememberable INTEGER NOT NULL DEFAULT 0,
  target_agent_id TEXT
);
`;

function stringList(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function connectorList(raw: string): Connector[] {
  const stored = stringList(raw);
  return CONNECTORS.filter((connector) => stored.includes(connector));
}

function record(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : {};
}

function engine(value: string): Engine {
  return value === "codex" ? "codex" : "claude-code";
}

function permissionMode(value: string): PermissionMode {
  return value === "accept-edits" ? "accept-edits" : "ask";
}

const MESSAGE_ROLES: readonly MessageRole[] = ["user", "assistant", "tool", "error"];
const APPROVAL_STATUSES: readonly ApprovalStatus[] = ["pending", "allowed", "denied", "expired"];
const RUN_STATUSES: readonly Run["status"][] = ["running", "done", "failed", "stopped"];

export type NewAgent = Omit<StoredAgent, "sessionId" | "createdAt" | "updatedAt" | "computerId">;
export type AgentPatch = Partial<Omit<StoredAgent, "id" | "createdAt" | "updatedAt">>;

export class Store {
  private readonly db: DatabaseSync;
  readonly tasks: TaskStore;
  readonly settings: SettingsStore;
  readonly schedules: ScheduleStore;
  readonly computers: ComputerStore;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.addMissingColumns();
    this.computers = new ComputerStore(this.db);
    this.tasks = new TaskStore(this.db);
    this.settings = new SettingsStore(this.db);
    this.schedules = new ScheduleStore(this.db);
  }

  private addMissingColumns(): void {
    const approvalColumns = columnsOf(this.db, "approvals");
    if (!approvalColumns.includes("rememberable")) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN rememberable INTEGER NOT NULL DEFAULT 0");
    }
    if (!approvalColumns.includes("target_agent_id")) this.db.exec("ALTER TABLE approvals ADD COLUMN target_agent_id TEXT");
    if (!approvalColumns.includes("tainted")) this.db.exec("ALTER TABLE approvals ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0");
    if (!approvalColumns.includes("display")) this.db.exec("ALTER TABLE approvals ADD COLUMN display TEXT");
    const agentColumns = columnsOf(this.db, "agents");
    if (!agentColumns.includes("computer")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN computer TEXT NOT NULL DEFAULT 'mac'");
    }
    if (!agentColumns.includes("daily_budget")) this.db.exec("ALTER TABLE agents ADD COLUMN daily_budget INTEGER");
    if (!agentColumns.includes("connectors")) this.db.exec("ALTER TABLE agents ADD COLUMN connectors TEXT NOT NULL DEFAULT '[]'");
  }

  close(): void {
    this.db.close();
  }

  listAgents(): StoredAgent[] {
    return this.db.prepare("SELECT * FROM agents ORDER BY created_at").all().map(toAgent);
  }

  getAgent(id: string): StoredAgent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    return row ? toAgent(row) : null;
  }

  insertAgent(agent: NewAgent, now: string): void {
    const computerId = agent.computer === "virtual" ? agent.id : null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (computerId) this.computers.createPrivateForAgent(computerId, agent.name, now);
      this.db
        .prepare(
          `INSERT INTO agents (id, name, role, engine, model, instructions, avatar_style, avatar_seed, use_my_setup,
         permission_mode, folders, allowed_tools, computer, computer_id, daily_budget, connectors, session_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
        )
        .run(
          agent.id, agent.name, agent.role, agent.engine, agent.model, agent.instructions, agent.avatarStyle,
          agent.avatarSeed, agent.useMySetup ? 1 : 0, agent.permissionMode, JSON.stringify(agent.folders),
          JSON.stringify(agent.allowedTools), agent.computer, computerId, agent.dailyBudget, JSON.stringify(agent.connectors), now, now,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateAgent(id: string, patch: AgentPatch, now: string): void {
    const columns: [string, string | number | null][] = [];
    if (patch.name !== undefined) columns.push(["name", patch.name]);
    if (patch.role !== undefined) columns.push(["role", patch.role]);
    if (patch.engine !== undefined) columns.push(["engine", patch.engine]);
    if (patch.model !== undefined) columns.push(["model", patch.model]);
    if (patch.instructions !== undefined) columns.push(["instructions", patch.instructions]);
    if (patch.avatarStyle !== undefined) columns.push(["avatar_style", patch.avatarStyle]);
    if (patch.avatarSeed !== undefined) columns.push(["avatar_seed", patch.avatarSeed]);
    if (patch.useMySetup !== undefined) columns.push(["use_my_setup", patch.useMySetup ? 1 : 0]);
    if (patch.permissionMode !== undefined) columns.push(["permission_mode", patch.permissionMode]);
    if (patch.folders !== undefined) columns.push(["folders", JSON.stringify(patch.folders)]);
    if (patch.allowedTools !== undefined) columns.push(["allowed_tools", JSON.stringify(patch.allowedTools)]);
    if (patch.computer !== undefined) {
      columns.push(["computer", patch.computer]);
      const current = this.getAgent(id);
      const computerId = patch.computer === "mac" ? null : current?.computerId ?? id;
      if (patch.computer === "virtual" && current?.computerId === null && current && !this.computers.get(id)) {
        this.computers.createPrivateForAgent(id, current.name, now);
      }
      if (current?.computerId && current.computerId !== computerId) this.computers.touchRevision(current.computerId, now);
      columns.push(["computer_id", computerId]);
    }
    if (patch.dailyBudget !== undefined) columns.push(["daily_budget", patch.dailyBudget]);
    if (patch.connectors !== undefined) columns.push(["connectors", JSON.stringify(patch.connectors)]);
    if (patch.sessionId !== undefined) columns.push(["session_id", patch.sessionId]);
    if (columns.length === 0) return;
    const assignments = columns.map(([column]) => `${column} = ?`).join(", ");
    this.db
      .prepare(`UPDATE agents SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...columns.map(([, value]) => value), now, id);
  }

  deleteAgent(id: string): void {
    this.db.prepare("DELETE FROM messages WHERE agent_id = ?").run(id);
    this.db.prepare("DELETE FROM approvals WHERE agent_id = ?").run(id);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    this.schedules.forgetAgent(id);
    this.tasks.forgetAgent(id);
  }

  addMessage(agentId: string, role: MessageRole, body: string, now: string): Message {
    const result = this.db
      .prepare("INSERT INTO messages (agent_id, role, text, created_at) VALUES (?,?,?,?)")
      .run(agentId, role, body, now);
    return { id: Number(result.lastInsertRowid), agentId, role, text: body, createdAt: now };
  }

  listMessages(agentId: string, limit: number): Message[] {
    return this.db
      .prepare("SELECT * FROM (SELECT * FROM messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(agentId, limit)
      .map((row) => ({
        id: number(row, "id"),
        agentId: text(row, "agent_id"),
        role: oneOf(text(row, "role"), MESSAGE_ROLES, "assistant"),
        text: text(row, "text"),
        createdAt: text(row, "created_at"),
      }));
  }

  insertRun(run: Run): void {
    this.db
      .prepare("INSERT INTO runs (id, agent_id, engine, model, started_at, status) VALUES (?,?,?,?,?,?)")
      .run(run.id, run.agentId, run.engine, run.model, run.startedAt, run.status);
  }

  finishRun(run: Run): void {
    this.db
      .prepare(
        "UPDATE runs SET ended_at = ?, status = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, error = ?, model = ? WHERE id = ?",
      )
      .run(run.endedAt, run.status, run.costUsd, run.inputTokens, run.outputTokens, run.error, run.model, run.id);
  }

  failInterruptedRuns(now: string): void {
    this.db.prepare("UPDATE runs SET status = 'failed', ended_at = ?, error = 'daemon restarted' WHERE status = 'running'").run(now);
    this.db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending'").run(now);
  }

  runsSince(iso: string): Run[] {
    return this.db.prepare("SELECT * FROM runs WHERE started_at >= ?").all(iso).map((row) => ({
      id: text(row, "id"),
      agentId: text(row, "agent_id"),
      engine: engine(text(row, "engine")),
      model: text(row, "model"),
      startedAt: text(row, "started_at"),
      endedAt: optionalText(row, "ended_at"),
      status: oneOf(text(row, "status"), RUN_STATUSES, "failed"),
      costUsd: number(row, "cost_usd"),
      inputTokens: number(row, "input_tokens"),
      outputTokens: number(row, "output_tokens"),
      error: optionalText(row, "error"),
    }));
  }

  insertApproval(approval: Approval): void {
    this.db
      .prepare(
        "INSERT INTO approvals (id, agent_id, tool_name, input, summary, status, rememberable, target_agent_id, tainted, display, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        approval.id, approval.agentId, approval.toolName, JSON.stringify(approval.input), approval.summary, approval.status,
        approval.rememberable ? 1 : 0, approval.targetAgentId, approval.tainted ? 1 : 0,
        approval.display === null ? null : JSON.stringify(approval.display), approval.createdAt,
      );
  }

  decideApproval(id: string, status: ApprovalStatus, now: string): void {
    this.db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, now, id);
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? toApproval(row) : null;
  }

  pendingApprovals(): Approval[] {
    return this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all().map(toApproval);
  }
}

function toAgent(row: Row): StoredAgent {
  const computerId = optionalText(row, "computer_id");
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    role: text(row, "role"),
    engine: engine(text(row, "engine")),
    model: text(row, "model"),
    instructions: text(row, "instructions"),
    avatarStyle: text(row, "avatar_style"),
    avatarSeed: text(row, "avatar_seed"),
    useMySetup: number(row, "use_my_setup") === 1,
    permissionMode: permissionMode(text(row, "permission_mode")),
    folders: stringList(text(row, "folders")),
    allowedTools: stringList(text(row, "allowed_tools")),
    computer: computerId === null ? "mac" : "virtual",
    computerId,
    dailyBudget: optionalNumber(row, "daily_budget"),
    connectors: connectorList(text(row, "connectors")),
    sessionId: optionalText(row, "session_id"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function toApproval(row: Row): Approval {
  return {
    id: text(row, "id"),
    agentId: text(row, "agent_id"),
    toolName: text(row, "tool_name"),
    input: record(text(row, "input")),
    summary: text(row, "summary"),
    status: oneOf(text(row, "status"), APPROVAL_STATUSES, "expired"),
    rememberable: number(row, "rememberable") === 1,
    targetAgentId: optionalText(row, "target_agent_id"),
    tainted: number(row, "tainted") === 1,
    display: storedDisplay(optionalText(row, "display")),
    createdAt: text(row, "created_at"),
    decidedAt: optionalText(row, "decided_at"),
  };
}
