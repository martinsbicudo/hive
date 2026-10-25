import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildNewAgent, ValidationError } from "../src/agents.ts";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import { ExportError } from "../src/export.ts";
import { ExportStaging } from "../src/exportStaging.ts";
import { EXPORT_TOOL } from "../src/hiveTools.ts";
import { Hub } from "../src/hub.ts";
import type { ComputerRunBinding } from "../src/runTokens.ts";
import { fakeDocker, removeTempDirs, tar, tempDir } from "./fixtures.ts";
import { until } from "./taskFixtures.ts";

const NOW = "2026-10-24T12:00:00.000Z";
const MB = 1024 * 1024;

after(() => removeTempDirs());

function exportHub(approvalTtlMs?: number) {
  const stageRoot = join(tempDir("hive-stage-"), "private");
  const docker = fakeDocker((args) => (args.includes("/bin/tar") ? { code: 0, stdout: tar([{ name: "report.txt", data: "private" }]), stderr: "" } : null));
  const store = new Store(":memory:");
  const agent = buildNewAgent({ name: "Vera", computer: "virtual" }, []);
  store.insertAgent(agent, NOW);
  const computers = new ComputerService({ docker: () => docker.runner, stageRoot, downloadsRoot: join(tempDir("hive-downloads-"), "Hive") });
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, computers, { approvalTtlMs });
  const staged = () => readdirSync(stageRoot).filter((name) => name.endsWith(".blob"));
  const ask = async (binding: ComputerRunBinding) => {
    const lease = { computerId: binding.computerId, computerRevision: binding.computerRevision, computerLeaseId: binding.computerLeaseId };
    const asked = await hub.computers.guest.exportFile(agent.id, "report.txt", lease, (snapshot) => hub.askToExport(agent.id, snapshot));
    assert.ok("approvalId" in asked);
    return asked.approvalId;
  };
  return { stageRoot, docker, store, agent, hub, staged, ask, close: async () => { await hub.shutdown(); store.close(); } };
}

describe("staged exports are dropped when nothing can use them", () => {
  it("drops the staged bytes when the user denies the export", async () => {
    const h = exportHub();
    try {
      const binding = await h.hub.computerManagement.prepare(h.agent.id);
      const approvalId = await h.ask(binding);
      assert.equal(h.staged().length, 1);
      h.hub.decideApproval(approvalId, false, false);
      assert.deepEqual(h.staged(), []);
      h.hub.computerManagement.release(binding);
    } finally {
      await h.close();
    }
  });

  it("drops the staged bytes when the approval expires", async () => {
    const h = exportHub(1);
    try {
      const binding = await h.hub.computerManagement.prepare(h.agent.id);
      const approvalId = await h.ask(binding);
      await until(() => h.store.getApproval(approvalId)?.status === "expired", "the export approval to expire");
      assert.deepEqual(h.staged(), []);
      h.hub.computerManagement.release(binding);
    } finally {
      await h.close();
    }
  });

  it("drops the staged bytes when their lease is released", async () => {
    const h = exportHub();
    try {
      const binding = await h.hub.computerManagement.prepare(h.agent.id);
      await h.ask(binding);
      assert.equal(h.staged().length, 1);
      h.hub.computerManagement.release(binding);
      assert.deepEqual(h.staged(), []);
    } finally {
      await h.close();
    }
  });

  it("clears the whole staging folder, claimed leftovers included, at startup and at shutdown", async () => {
    const h = exportHub();
    const fill = () => {
      mkdirSync(h.stageRoot, { recursive: true, mode: 0o700 });
      const [id, other] = [randomUUID(), randomUUID()];
      for (const name of [`${id}.json`, `${id}.blob`, `${id}.${other}.tmp`, `${id}.${other}.claimed`, `${id}.${other}.claimed.json`]) writeFileSync(join(h.stageRoot, name), "x");
      writeFileSync(join(h.stageRoot, "notes.txt"), "not Hive's");
    };
    fill();
    h.hub.computers.clearStagedExports();
    assert.deepEqual(readdirSync(h.stageRoot), ["notes.txt"]);
    fill();
    await h.close();
    assert.deepEqual(readdirSync(h.stageRoot), ["notes.txt"]);
  });
});

describe("export card", () => {
  it("shows bidi and zero-width characters in the file name and path as visible escapes", () => {
    const h = exportHub();
    try {
      const filename = "invoice‮txt.exe​";
      const id = h.hub.askToExport(h.agent.id, {
        stagedExportId: randomUUID(), computerId: h.agent.id, computerRevision: 1, computerLeaseId: randomUUID(),
        path: "/home/agent/workspace/⁦safe⁩/report.txt", filename, size: 3, sha256: "a".repeat(64),
      });
      const summary = h.store.getApproval(id)?.summary ?? "";
      assert.match(summary, /invoice\[U\+202E\]txt\.exe\[U\+200B\]/);
      assert.match(summary, /\[U\+2066\]safe\[U\+2069\]/);
      assert.ok(!/[‮​⁦⁩]/.test(summary));
    } finally {
      void h.close();
    }
  });
});

describe("export quota", () => {
  it("limits each agent on its own, so one agent can't use up the space every agent shares", async () => {
    const stageRoot = join(tempDir("hive-stage-"), "private");
    const gate = Promise.withResolvers<void>();
    const exec = async () => {
      await gate.promise;
      return { code: 0, stdout: tar([{ name: "a.txt", data: "x" }]), stderr: "" };
    };
    const staging = new ExportStaging({ stageRoot, agentLimitBytes: 100 * MB, totalLimitBytes: 250 * MB });
    const context = () => ({ computerId: randomUUID(), computerRevision: 1, computerLeaseId: randomUUID() });
    const [ana, bob] = [randomUUID(), randomUUID()];
    const first = staging.stage(ana, context(), "a.txt", exec, () => true);
    await assert.rejects(staging.stage(ana, context(), "b.txt", exec, () => true), (error) => error instanceof ExportError && error.reason === "quota" && /this agent/.test(error.message));
    const other = staging.stage(bob, context(), "a.txt", exec, () => true);
    gate.resolve();
    await Promise.all([first, other]);
    assert.equal(readdirSync(stageRoot).filter((name) => name.endsWith(".blob")).length, 2);
    assert.equal(existsSync(stageRoot), true);
  });
});

describe("export cards", () => {
  it("refuses a staged-export snapshot on the generic approval path, so only the named, sized and hashed card can allow it", async () => {
    const h = exportHub();
    try {
      const binding = await h.hub.computerManagement.prepare(h.agent.id);
      const approvalId = await h.ask(binding);
      const card = h.store.getApproval(approvalId);
      assert.ok(card);
      assert.match(card.summary, /^Export report\.txt \(7 bytes, SHA-256 [0-9a-f]{64}\) from /);
      const pending = h.store.pendingApprovals().length;
      assert.throws(() => h.hub.requestApproval(h.agent.id, EXPORT_TOOL, { ...card.input }), ValidationError);
      assert.equal(h.store.pendingApprovals().length, pending);
      const plain = h.hub.requestApproval(h.agent.id, EXPORT_TOOL, { path: "report.txt" });
      assert.equal(plain.autoAllowed, false);
      h.hub.decideApproval(plain.id, true, false);
      const lease = { computerId: binding.computerId, computerRevision: binding.computerRevision, computerLeaseId: binding.computerLeaseId };
      const again = await h.hub.computers.guest.exportFile(h.agent.id, "report.txt", lease, (snapshot) => h.hub.askToExport(h.agent.id, snapshot));
      assert.ok("approvalId" in again, "a generic approval let the staged file out");
      h.hub.computerManagement.release(binding);
    } finally {
      await h.close();
    }
  });
});
