import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { ensureDirs } from "../src/paths.ts";
import { clock, failingEngine, local, notifications } from "./controlFixtures.ts";
import { call, fakeDocker, removeTempDirs } from "./fixtures.ts";
import { addAgent, context, hubHarness, UI_SECRET, until } from "./taskFixtures.ts";

after(removeTempDirs);

async function harness() {
  const c = clock(local(10, 21, 8, 0));
  const h = await hubHarness(undefined, { now: c.now });
  const api = (method: string, path: string, body?: unknown) => call(h.port, method, path, { token: UI_SECRET, body });
  return { ...h, api };
}

describe("notify events", () => {
  it("one per new approval, naming the agent and never the tool input", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      const max = h.agent({ name: "Max" });
      h.agent({ name: "Vera", computer: "virtual" });
      const notes = notifications(h.hub);
      h.hub.requestApproval(ana.id, "Bash", { command: "rm -rf /private-path-xyz" });
      assert.deepEqual(notes.map((note) => [note.kind, note.text, note.agentId, note.taskId]), [["approval", "Ana is waiting for your approval.", ana.id, undefined]]);
      h.hub.requestApproval(ana.id, "Write", { file_path: "/private-path-xyz/notes.txt" });
      assert.equal(notes.length, 2);
      const taskId = h.hub.tasks.create({ title: "Secret title", description: "secret body" }).id;
      h.hub.tasks.act(context(max.id), "handoff_task", { taskId, to: "Vera", note: "secret note" });
      assert.equal(notes.length, 3);
      assert.deepEqual([notes[2]?.kind, notes[2]?.taskId, notes[2]?.agentId], ["approval", taskId, max.id]);
      assert.ok(notes.every((note) => !JSON.stringify(note).includes("secret") && !JSON.stringify(note).includes("private-path")));
    } finally {
      await h.close();
    }
  });

  it("a paused event once per pause, and none on resume", async () => {
    const h = await harness();
    try {
      const notes = notifications(h.hub);
      await h.api("POST", "/api/pause");
      await h.api("POST", "/api/pause");
      await h.api("POST", "/api/resume");
      assert.deepEqual(notes.map((note) => note.kind), ["paused"]);
      await h.api("POST", "/api/pause");
      assert.deepEqual(notes.map((note) => note.kind), ["paused", "paused"]);
    } finally {
      await h.close();
    }
  });

  it("a failed event once per failed run, without the error text", async () => {
    ensureDirs();
    const store = new Store(":memory:");
    const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService(), { findEngine: () => failingEngine() });
    try {
      const ana = addAgent(store, { name: "Ana" });
      const notes = notifications(hub);
      hub.send(ana.id, "one");
      await until(() => notes.length === 1, "the first failure");
      hub.send(ana.id, "two");
      await until(() => notes.length === 2, "the second failure");
      assert.deepEqual(notes.map((note) => [note.kind, note.text, note.agentId]), [["failed", "Ana's run failed.", ana.id], ["failed", "Ana's run failed.", ana.id]]);
      assert.ok(hub.messages(ana.id, 10).some((message) => message.text.includes("secret boom detail")));
    } finally {
      hub.shutdown();
    }
  });

  it("a run that fails before it has a Run row also sends one failed event", async () => {
    ensureDirs();
    const store = new Store(":memory:");
    const docker = fakeDocker(() => ({ code: 1, stdout: Buffer.from(""), stderr: "docker secret detail" }));
    const missing = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ docker: () => docker.runner }), { findEngine: () => null });
    try {
      const ana = addAgent(store, { name: "Ana" });
      const vera = addAgent(store, { name: "Vera", computer: "virtual" });
      const notes = notifications(missing);
      missing.send(ana.id, "hello");
      assert.deepEqual(notes.map((note) => [note.kind, note.text, note.agentId]), [["failed", "Ana's run failed.", ana.id]]);
      missing.send(vera.id, "hello");
      await until(() => notes.length === 2, "the virtual computer failure");
      assert.deepEqual([notes[1]?.kind, notes[1]?.text, notes[1]?.agentId], ["failed", "Vera's run failed.", vera.id]);
      assert.ok(notes.every((note) => !note.text.includes("secret")));
    } finally {
      missing.shutdown();
    }
  });

  it("a run refused because Hive is paused sends no budget event", async () => {
    const h = await harness();
    try {
      const ana = h.agent({ name: "Ana" });
      const notes = notifications(h.hub);
      await h.api("POST", "/api/pause");
      h.hub.send(ana.id, "hello");
      assert.deepEqual(notes.map((note) => note.kind), ["paused"]);
    } finally {
      await h.close();
    }
  });
});
