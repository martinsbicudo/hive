import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { MAC_CONNECTOR_TOOLS } from "../src/connectors.ts";
import { githubTool } from "../src/githubTool.ts";
import type { Connector } from "../src/types.ts";
import { call, fakeCommands, field, removeTempDirs, tempDir } from "./fixtures.ts";
import { COMMENT, GH } from "./githubFixtures.ts";
import { EMAIL } from "./macFixtures.ts";
import { context, hubHarness, UI_SECRET } from "./taskFixtures.ts";

after(removeTempDirs);

function text(value: unknown, key: string): string {
  const found = field(value, key);
  assert.equal(typeof found, "string", key);
  return typeof found === "string" ? found : "";
}

describe("step 6 end to end: templates and connectors with fake gh and osascript", () => {
  it("creates agents from templates, auto-allows a gh read, holds a gh write and a mail send, runs nothing on deny", async () => {
    const commands = fakeCommands(() => ({ stdout: "#7 Fix the thing" }));
    const h = await hubHarness(undefined, {
      commands: commands.runner,
      connectorTools: [githubTool({ findGh: () => GH, tmpRoot: () => tempDir("hive-e2e6-") }), ...MAC_CONNECTOR_TOOLS],
    });
    const ui = (method: string, path: string, body?: unknown) => call(h.port, method, path, { token: UI_SECRET, body });
    const created: string[] = [];
    try {
      const templates = (await ui("GET", "/api/templates")).body;
      assert.ok(Array.isArray(templates));
      const fromTemplate = async (name: string) => {
        const template = templates.find((entry) => field(entry, "name") === name);
        assert.ok(template, name);
        const avatar = field(template, "avatar");
        const body = {
          name: field(template, "name"), role: field(template, "role"), instructions: field(template, "instructions"),
          engine: field(template, "engine"), computer: field(template, "computer"), permissionMode: field(template, "permissionMode"),
          connectors: field(template, "connectors"), avatarStyle: field(avatar, "style"),
        };
        const agent = await ui("POST", "/api/agents", body);
        assert.equal(agent.status, 201, name);
        const id = text(agent.body, "id");
        created.push(id);
        const schedules = field(template, "schedules");
        assert.ok(Array.isArray(schedules));
        for (const schedule of schedules) assert.equal((await ui("POST", `/api/agents/${id}/schedules`, schedule)).status, 201, name);
        const stored = await ui("GET", `/api/agents/${id}/schedules`);
        assert.ok(Array.isArray(stored.body));
        assert.equal(stored.body.length, schedules.length, name);
        return { id, connectors: h.store.getAgent(id)?.connectors };
      };

      const reviewer = await fromTemplate("Code Reviewer");
      const inbox = await fromTemplate("Inbox Assistant");
      assert.deepEqual(reviewer.connectors, ["github"]);
      assert.deepEqual(inbox.connectors, ["mail"]);

      const tokenFor = (id: string, launched: Connector[]) => h.hub.runTokens.issue(id, context(id, { launchedConnectors: launched }));
      const reviewerToken = tokenFor(reviewer.id, ["github"]);
      const inboxToken = tokenFor(inbox.id, ["mail"]);
      const connector = (token: string, route: string, body: unknown) => call(h.port, "POST", `/internal/connectors/${route}`, { token, body });

      const read = await connector(reviewerToken, "github", { args: ["pr", "list", "-R", "o/r"] });
      assert.equal(read.status, 200);
      assert.match(text(read.body, "result"), /From GitHub \(external\)/);
      assert.equal(h.hub.state().approvals.length, 0, "a read creates no approval");
      assert.equal(commands.calls.length, 1);

      const write = await connector(reviewerToken, "github", { args: COMMENT });
      const writeId = text(write.body, "approvalId");
      assert.equal(h.store.getApproval(writeId)?.status, "pending");
      assert.equal(commands.calls.length, 1, "a write runs nothing while pending");

      const send = await connector(inboxToken, "mail_send", EMAIL);
      const sendId = text(send.body, "approvalId");
      assert.equal(h.store.getApproval(sendId)?.status, "pending");
      assert.equal(commands.calls.length, 1, "a send runs nothing while pending");

      h.hub.decideApproval(sendId, false, false);
      assert.deepEqual((await connector(inboxToken, "wait", { approvalId: sendId })).body, { status: "denied" });
      h.hub.decideApproval(writeId, false, false);
      assert.deepEqual((await connector(reviewerToken, "wait", { approvalId: writeId })).body, { status: "denied" });
      assert.equal(commands.calls.length, 1, "nothing ran after the denials");
      assert.equal(commands.calls.filter((entry) => entry.file.endsWith("osascript")).length, 0);
      for (const id of created.splice(0)) assert.equal((await ui("DELETE", `/api/agents/${id}`)).status, 200);
      assert.equal(h.hub.state().agents.length, 0, "state is clean");
    } finally {
      await h.close();
    }
  });
});
