import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { log } from "./log.ts";
import { columnsOf, flag, number, optionalText, text, type Row } from "./sqlRows.ts";
import type { Computer, ComputerEngine, ComputerMember, ComputerProfile, ComputerResource, ComputerRuntime } from "./computerTypes.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS computers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT NOT NULL, profile TEXT NOT NULL,
  revision INTEGER NOT NULL, managed INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS computer_migrations (name TEXT PRIMARY KEY);
`;

const RUNTIMES = ["docker"] as const;
const PROFILES = ["terminal", "browser", "desktop"] as const;
const ENGINES = ["docker-desktop", "orbstack"] as const;
const ComputerRow = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  runtime: z.enum(RUNTIMES),
  profile: z.enum(PROFILES),
  engine: z.enum(ENGINES).nullable(),
  revision: z.number().int().positive(),
  managed: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export interface NewComputer {
  id: string;
  name: string;
  runtime: ComputerRuntime;
  profile: ComputerProfile;
  managed: boolean;
  now: string;
}

export class ComputerStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.migrateLegacyAgents();
  }

  create(input: NewComputer): Computer {
    const computer = ComputerRow.parse({
      id: input.id, name: input.name, runtime: input.runtime, profile: input.profile, engine: null, revision: 1,
      managed: input.managed, createdAt: input.now, updatedAt: input.now,
    });
    this.insert(computer);
    return computer;
  }

  createManaged(name: string, runtime: ComputerRuntime, profile: ComputerProfile, now: string): Computer {
    return this.create({ id: randomUUID(), name, runtime, profile, managed: true, now });
  }

  createPrivateForAgent(agentId: string, agentName: string, now: string): Computer {
    return this.create({ id: agentId, name: `${agentName}'s computer`, runtime: "docker", profile: "desktop", managed: false, now });
  }

  get(id: string): Computer | null {
    const row = this.db.prepare("SELECT * FROM computers WHERE id = ?").get(id);
    return row ? toComputer(row) : null;
  }

  list(): Computer[] {
    return this.db.prepare("SELECT * FROM computers ORDER BY created_at, id").all().map(toComputer);
  }

  resource(id: string): ComputerResource | null {
    const computer = this.get(id);
    return computer ? { ...computer, members: this.members(id) } : null;
  }

  forAgent(agentId: string): ComputerResource | null {
    const row = this.db.prepare("SELECT computer_id FROM agents WHERE id = ?").get(agentId);
    const id = row ? optionalText(row, "computer_id") : null;
    return id ? this.resource(id) : null;
  }

  resources(): ComputerResource[] {
    return this.list().map((computer) => ({ ...computer, members: this.members(computer.id) }));
  }

  assign(agentId: string, computerId: string, now: string): boolean {
    if (!this.get(computerId)) return false;
    const old = this.db.prepare("SELECT computer_id FROM agents WHERE id = ?").get(agentId);
    if (!old) return false;
    const oldId = optionalText(old, "computer_id");
    if (oldId === computerId) return true;
    const result = this.db.prepare("UPDATE agents SET computer = 'virtual', computer_id = ?, updated_at = ? WHERE id = ?").run(computerId, now, agentId);
    if (oldId) this.bumpRevision(oldId, now);
    this.bumpRevision(computerId, now);
    return result.changes > 0;
  }

  detach(agentId: string, now: string): boolean {
    const old = this.db.prepare("SELECT computer_id FROM agents WHERE id = ?").get(agentId);
    if (!old) return false;
    const oldId = optionalText(old, "computer_id");
    const result = this.db.prepare("UPDATE agents SET computer = 'mac', computer_id = NULL, updated_at = ? WHERE id = ?").run(now, agentId);
    if (oldId) this.bumpRevision(oldId, now);
    return result.changes > 0;
  }

  deletePrivateIfUnused(id: string): boolean {
    const result = this.db.prepare("DELETE FROM computers WHERE id = ? AND managed = 0 AND NOT EXISTS (SELECT 1 FROM agents WHERE computer_id = ?)").run(id, id);
    return result.changes > 0;
  }

  deleteManagedIfUnused(id: string): boolean {
    const result = this.db.prepare("DELETE FROM computers WHERE id = ? AND managed = 1 AND NOT EXISTS (SELECT 1 FROM agents WHERE computer_id = ?)").run(id, id);
    return result.changes > 0;
  }

  promoteToManaged(id: string, now: string): boolean {
    const result = this.db.prepare("UPDATE computers SET managed = 1, revision = revision + 1, updated_at = ? WHERE id = ? AND managed = 0").run(now, id);
    return result.changes > 0;
  }

  touchRevision(id: string, now: string): void {
    this.bumpRevision(id, now);
  }

  rename(id: string, name: string, now: string): boolean {
    return this.db.prepare("UPDATE computers SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id).changes > 0;
  }

  update(id: string, patch: Partial<Pick<Computer, "name" | "runtime" | "profile" | "managed">>, now: string): Computer | null {
    const current = this.get(id);
    if (!current) return null;
    const next = ComputerRow.parse({ ...current, ...patch, revision: current.revision + 1, updatedAt: now });
    this.db.prepare(
      "UPDATE computers SET name = ?, runtime = ?, profile = ?, revision = ?, managed = ?, updated_at = ? WHERE id = ?",
    ).run(next.name, next.runtime, next.profile, next.revision, next.managed ? 1 : 0, next.updatedAt, id);
    return next;
  }

  setEngine(id: string, engine: ComputerEngine, now: string): boolean {
    return this.db.prepare("UPDATE computers SET engine = ?, updated_at = ? WHERE id = ?").run(engine, now, id).changes > 0;
  }

  private migrateLegacyAgents(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!columnsOf(this.db, "agents").includes("computer_id")) this.db.exec("ALTER TABLE agents ADD COLUMN computer_id TEXT");
      if (!columnsOf(this.db, "computers").includes("engine")) {
        this.db.exec("ALTER TABLE computers ADD COLUMN engine TEXT");
        // Older builds ran Docker computers only on Docker Desktop, so their homes are there even when it isn't running now.
        this.db.exec("UPDATE computers SET engine = 'docker-desktop' WHERE runtime = 'docker'");
      }
      this.repairOlderBuildSwitches(new Date().toISOString());
      // Apple Container support was removed; such a computer could never start, and Docker is the only runtime left.
      this.db.exec("UPDATE computers SET runtime = 'docker' WHERE runtime <> 'docker'");
      const agents = this.db.prepare("SELECT id, name, created_at, updated_at FROM agents WHERE computer = 'virtual' AND computer_id = id").all();
      for (const row of agents) {
        const agentId = text(row, "id");
        this.db.prepare(
          "INSERT OR IGNORE INTO computers (id, name, runtime, profile, revision, managed, created_at, updated_at) VALUES (?,?, 'docker', 'desktop', 1, 0, ?,?)",
        ).run(agentId, `${text(row, "name")}'s computer`, text(row, "created_at"), text(row, "updated_at"));
      }
      this.db.prepare("INSERT OR IGNORE INTO computer_migrations (name) VALUES (?)").run("agent-computer-id-v1");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Runs on every open: an older build switches only agents.computer, so computer_id can disagree with it.
  private repairOlderBuildSwitches(now: string): void {
    const leftForMac = this.db.prepare("SELECT DISTINCT computer_id FROM agents WHERE computer = 'mac' AND computer_id IS NOT NULL").all();
    this.db.exec("UPDATE agents SET computer_id = NULL WHERE computer = 'mac' AND computer_id IS NOT NULL");
    for (const row of leftForMac) this.bumpRevision(text(row, "computer_id"), now);
    const rejoining = this.db.prepare(
      "SELECT a.id, c.managed FROM agents a JOIN computers c ON c.id = a.id WHERE a.computer = 'virtual' AND a.computer_id IS NULL",
    ).all();
    this.db.exec("UPDATE agents SET computer_id = id WHERE computer = 'virtual' AND computer_id IS NULL");
    for (const row of rejoining) {
      const id = text(row, "id");
      this.bumpRevision(id, now);
      if (flag(row, "managed")) log(`agent ${id} rejoined its old computer, now shared, after an older build moved it back to virtual`);
    }
  }

  private insert(computer: Computer): void {
    this.db.prepare(
      "INSERT INTO computers (id, name, runtime, profile, engine, revision, managed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(computer.id, computer.name, computer.runtime, computer.profile, computer.engine, computer.revision, computer.managed ? 1 : 0, computer.createdAt, computer.updatedAt);
  }

  private members(computerId: string): ComputerMember[] {
    return this.db.prepare("SELECT id, name FROM agents WHERE computer_id = ? ORDER BY name COLLATE NOCASE, id").all(computerId).map((row) => ({
      agentId: text(row, "id"), name: text(row, "name"),
    }));
  }

  private bumpRevision(id: string, now: string): void {
    this.db.prepare("UPDATE computers SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, id);
  }
}

function toComputer(row: Row): Computer {
  return ComputerRow.parse({
    id: text(row, "id"), name: text(row, "name"), runtime: text(row, "runtime"), profile: text(row, "profile"), engine: optionalText(row, "engine"),
    revision: number(row, "revision"), managed: flag(row, "managed"), createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at"),
  });
}
