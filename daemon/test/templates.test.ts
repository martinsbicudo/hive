import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { buildSchedule } from "../src/scheduleInput.ts";
import { startServer } from "../src/server.ts";
import { TEMPLATES, templateShape } from "../src/templates.ts";
import { call, field, freePort } from "./fixtures.ts";

const NOW = "2026-10-22T12:00:00.000Z";
const UI_SECRET = "u".repeat(64);

describe("templates", () => {
  it("has the seven templates", () => {
    assert.deepEqual(TEMPLATES.map((template) => template.name), [
      "Code Reviewer", "Daily Briefing", "Inbox Assistant", "Researcher", "Marketing Writer", "Lead Finder", "Content Creator",
    ]);
  });

  it("gives each template a role that differs from its name", () => {
    for (const template of TEMPLATES) assert.notEqual(template.role, template.name);
  });

  it("passes agent and schedule validation, and never asks for more than ask mode", () => {
    for (const template of TEMPLATES) {
      const agent = buildNewAgent({ ...template, avatarStyle: template.avatar.style }, []);
      assert.equal(agent.permissionMode, "ask", template.name);
      assert.deepEqual(agent.allowedTools, [], template.name);
      assert.deepEqual(agent.folders, [], template.name);
      assert.deepEqual(agent.connectors, template.connectors, template.name);
      for (const schedule of template.schedules) buildSchedule(schedule, agent.id, NOW);
    }
  });

  it("wires the connectors and schedules the plan names", () => {
    const named = (name: string) => TEMPLATES.find((template) => template.name === name);
    assert.deepEqual(named("Code Reviewer")?.connectors, ["github"]);
    assert.equal(named("Code Reviewer")?.schedules[0]?.everyMinutes, 60);
    assert.deepEqual(named("Daily Briefing")?.connectors, ["mail", "calendar"]);
    assert.equal(named("Daily Briefing")?.schedules[0]?.kind, "weekdays");
    assert.equal(named("Daily Briefing")?.schedules[0]?.at, "08:30");
    assert.match(named("Daily Briefing")?.instructions ?? "", /never instructions/);
    assert.equal(named("Lead Finder")?.computer, "virtual");
    assert.match(named("Content Creator")?.notes.join(" ") ?? "", /Use my/);
  });

  it("refuses fields a template can't have", () => {
    const base = templateShape.parse(TEMPLATES[0]);
    for (const extra of [{ allowedTools: ["Bash"] }, { folders: ["/tmp"] }, { useMySetup: true }, { model: "opus" }]) {
      assert.equal(templateShape.safeParse({ ...base, ...extra }).success, false, JSON.stringify(extra));
    }
    assert.equal(templateShape.safeParse({ ...base, permissionMode: "accept-edits" }).success, false);
  });
});

describe("GET /api/templates", () => {
  const store = new Store(":memory:");
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" });
  let server: Server;
  let port = 0;

  before(async () => {
    port = await freePort();
    server = startServer({ hub, uiSecret: UI_SECRET, port, webDir: "/nonexistent" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    hub.shutdown();
  });

  it("returns the seven templates to the UI secret only", async () => {
    const reply = await call(port, "GET", "/api/templates", { token: UI_SECRET });
    assert.equal(reply.status, 200);
    assert.ok(Array.isArray(reply.body));
    assert.equal(reply.body.length, 7);
    assert.equal(field(reply.body[0], "name"), "Code Reviewer");
    assert.equal((await call(port, "GET", "/api/templates")).status, 401);
    assert.equal((await call(port, "GET", "/api/templates", { token: "x".repeat(64) })).status, 401);
  });

  it("uses the avatarSeed given to POST /api/agents, and picks one when absent", async () => {
    const given = await call(port, "POST", "/api/agents", { token: UI_SECRET, body: { name: "Ana", avatarSeed: "code-reviewer" } });
    assert.equal(given.status, 201);
    assert.equal(field(given.body, "avatarSeed"), "code-reviewer");
    const random = await call(port, "POST", "/api/agents", { token: UI_SECRET, body: { name: "Bo" } });
    assert.match(String(field(random.body, "avatarSeed")), /^Bo-[0-9a-f]{8}$/);
  });

  it("refuses an invalid avatarSeed", async () => {
    for (const avatarSeed of ["", " ", "-x", "a".repeat(81), "a/b", "a\nb", 7, null, ["x"]]) {
      const reply = await call(port, "POST", "/api/agents", { token: UI_SECRET, body: { name: "Cy", avatarSeed } });
      assert.equal(reply.status, 400, JSON.stringify(avatarSeed));
    }
  });
});
