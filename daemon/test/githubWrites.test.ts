import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { call, field, removeTempDirs } from "./fixtures.ts";
import { COMMENT, GH, ghHarness } from "./githubFixtures.ts";
import { NOW } from "./taskFixtures.ts";

after(removeTempDirs);

const CANONICAL = ["pr", "comment", "7", "--repo", "o/r", "--body", "Looks good to me"];

describe("github tool writes", () => {
  it("asks with the canonical argv and full body on the card, never rememberable", async () => {
    const h = await ghHarness();
    try {
      const rita = h.reviewer();
      const { token } = h.tokenFor(rita.id);
      const body = `Long review:\n\n${"all good, ".repeat(150)}\n- end`;
      const asked = await h.ask(token, ["pr", "comment", "7", "-R", "o/r", "-b", body]);
      assert.equal(asked.reply.status, 200);
      const card = h.hub.state().approvals.find((approval) => approval.id === asked.approvalId);
      assert.equal(card?.toolName, "mcp__hive__github");
      assert.deepEqual(card?.input, { args: ["pr", "comment", "7", "--repo", "o/r", "--body", body] });
      assert.equal(card?.summary, `gh pr comment 7 --repo o/r --body '${body}'`);
      assert.equal(card?.rememberable, false);
      assert.equal(h.commands.calls.length, 0);
    } finally {
      await h.close();
    }
  });

  it("runs gh pr comment once after approval; remember stores no rule and it asks again", async () => {
    const h = await ghHarness(() => ({ stdout: "https://github.com/o/r/pull/7#issuecomment-1" }));
    try {
      const rita = h.reviewer();
      const { ctx, token } = h.tokenFor(rita.id);
      const first = await h.ask(token);
      h.hub.decideApproval(first.approvalId, true, true);
      const outcome = await h.wait(token, first.approvalId);
      assert.equal(field(outcome.body, "status"), "allowed");
      assert.match(String(field(outcome.body, "result")), /From GitHub \(external\)[\s\S]*issuecomment-1/);
      assert.equal(ctx.tainted, true);
      assert.deepEqual(h.commands.calls.map((entry) => [entry.file, entry.args]), [[GH, CANONICAL]]);
      assert.deepEqual(h.store.getAgent(rita.id)?.allowedTools, []);
      const again = await h.ask(token);
      assert.notEqual(again.approvalId, "");
      assert.equal(h.store.getApproval(again.approvalId)?.status, "pending");
      assert.equal(h.commands.calls.length, 1);
    } finally {
      await h.close();
    }
  });

  it("runs nothing on deny", async () => {
    const h = await ghHarness();
    try {
      const { token } = h.tokenFor(h.reviewer().id);
      const asked = await h.ask(token);
      h.hub.decideApproval(asked.approvalId, false, false);
      assert.deepEqual((await h.wait(token, asked.approvalId)).body, { status: "denied" });
      assert.equal(h.commands.calls.length, 0);
    } finally {
      await h.close();
    }
  });

  it("a second request with another body can't change what the pending one runs", async () => {
    const h = await ghHarness();
    try {
      const { token } = h.tokenFor(h.reviewer().id);
      const first = await h.ask(token);
      const second = await h.ask(token, ["pr", "comment", "7", "-R", "o/r", "-b", "Approved, merge at will", "--edit-last"]);
      assert.equal(second.reply.status, 409);
      assert.match(String(field(second.reply.body, "error")), /one send at a time/);
      h.hub.decideApproval(first.approvalId, true, false);
      await h.wait(token, first.approvalId);
      assert.deepEqual(h.commands.calls.map((entry) => entry.args), [CANONICAL]);
    } finally {
      await h.close();
    }
  });

  it("answers 400 for a refused call and runs or asks nothing", async () => {
    const h = await ghHarness();
    try {
      const { token } = h.tokenFor(h.reviewer().id);
      for (const args of [["api", "https://x/y"], ["pr", "list", "--repo=evil.com/o/r"], ["pr", "zz"], ["auth", "token"], ["api", "-XPOST", "repos/o/r"]]) {
        const reply = await h.gh(token, args);
        assert.equal(reply.status, 400, args.join(" "));
        assert.match(String(field(reply.body, "error")), /^Hive refused this gh call: /);
      }
      assert.equal((await h.gh(token, [])).status, 400);
      assert.equal((await h.gh(token, "pr list")).status, 400);
      assert.equal((await call(h.port, "POST", "/internal/connectors/github", { token, body: { args: ["pr", "list", "-R", "o/r"], cwd: "/" } })).status, 400);
      assert.equal(h.commands.calls.length + h.hub.state().approvals.length, 0);
    } finally {
      await h.close();
    }
  });

  it("answers 403 for virtual, Codex, connector-less and mail-only agents", async () => {
    const h = await ghHarness();
    try {
      const vic = h.reviewer({ name: "Vic" });
      h.store.updateAgent(vic.id, { computer: "virtual" }, NOW);
      const cody = h.reviewer({ name: "Cody" });
      h.store.updateAgent(cody.id, { engine: "codex" }, NOW);
      const plain = h.agent({ name: "Pia" });
      const mo = h.agent({ name: "Mo", connectors: ["mail"] });
      const launched = h.reviewer({ name: "Lu" });
      const tokens = [vic, cody, plain, mo].map((agent) => h.tokenFor(agent.id).token);
      tokens.push(h.tokenFor(launched.id, { launchedVirtual: true }).token);
      for (const token of tokens) {
        assert.equal((await h.gh(token, ["pr", "list", "-R", "o/r"])).status, 403);
        assert.equal((await h.gh(token, COMMENT)).status, 403);
      }
      assert.equal(h.commands.calls.length + h.hub.state().approvals.length, 0);
    } finally {
      await h.close();
    }
  });

  it("re-checks the github connector before running an approved write", async () => {
    const h = await ghHarness();
    try {
      const rita = h.reviewer();
      const { token } = h.tokenFor(rita.id);
      const asked = await h.ask(token);
      h.store.updateAgent(rita.id, { connectors: [] }, NOW);
      h.hub.decideApproval(asked.approvalId, true, false);
      assert.match(String(field((await h.wait(token, asked.approvalId)).body, "error")), /can't use the github connector/);
      assert.equal(h.commands.calls.length, 0);
    } finally {
      await h.close();
    }
  });
});
