import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { freshArchitectCwd } from "../src/architect.ts";
import { ArchitectGuard, TOOL_MESSAGE, UNCHECKED_OUTPUT, UNSAFE_START } from "../src/architectGuard.ts";
import { parseClaudeEvent, type EngineEvent } from "../src/engines.ts";
import { spawnEngine } from "../src/runProcess.ts";
import { architectHarness, json, proposal, user } from "./architectFixtures.ts";
import { BUILT_IN_PLUGINS, probeInit } from "./fakeArchitect.ts";
import { field, removeTempDirs, tempDir } from "./fixtures.ts";

after(removeTempDirs);

const LATER = { sleepMs: 4000 };

async function killedWith(init: unknown, error: string, steps: unknown[] = [LATER, { say: "should never arrive" }]) {
  const h = await architectHarness();
  try {
    h.script([{ init, steps: steps.map((step) => Object(step)) }]);
    const started = Date.now();
    const reply = await h.turn([user("hi")]);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { reply: "", proposal: null, error });
    assert.ok(Date.now() - started < 3500, "the run was killed, not waited for");
    assert.equal(h.finished(), 0);
    assert.deepEqual(h.store.runsSince("1970-01-01T00:00:00.000Z").map((run) => [run.status, run.error]), [["failed", error]]);
  } finally {
    h.close();
  }
}

describe("the Architect's stream guard", () => {
  it("accepts the three built-in plugins the probe saw", async () => {
    const h = await architectHarness();
    try {
      h.script([{ init: probeInit({ plugins: BUILT_IN_PLUGINS }), steps: [{ say: "What should it do?" }] }]);
      assert.deepEqual((await h.turn([user("hi")])).body, { reply: "What should it do?", proposal: null });
    } finally {
      h.close();
    }
  });

  it("rejects a reply with no init event", () => killedWith(null, UNSAFE_START, [{ say: "text before any init" }, LATER]));

  it("kills a run whose init lists tools", () => killedWith(probeInit({ tools: ["Bash"] }), UNSAFE_START));

  it("kills a run whose init lists MCP servers", () => killedWith(probeInit({ mcp_servers: [{ name: "x", status: "connected" }] }), UNSAFE_START));

  it("kills a run whose init has no tool list", () => killedWith(probeInit({ tools: undefined }), UNSAFE_START));

  for (const plugin of [
    { name: "x", path: "builtin", source: "x@evil" },
    { name: "x", path: "/abs/plugins/x", source: "x@builtin" },
    { name: "x", path: "builtin", source: "y@builtin" },
  ]) {
    it(`kills a run with the plugin ${JSON.stringify(plugin)}`, () => killedWith(probeInit({ plugins: [...BUILT_IN_PLUGINS, plugin] }), UNSAFE_START));
  }

  for (const type of ["tool_use", "server_tool_use"]) {
    it(`kills a run whose reply holds a ${type} block and discards its text`, () =>
      killedWith(undefined, TOOL_MESSAGE, [
        { emit: { type: "assistant", message: { content: [{ type: "text", text: json(proposal()) }, { type, id: "t1", name: "web_search", input: {} }] } } },
        LATER,
        { say: "should never arrive" },
      ]));
  }

  it("keeps thinking blocks out of the reply but lets them pass", async () => {
    const h = await architectHarness();
    try {
      h.script([{ steps: [{ emit: { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Which inbox?" }] } } }] }]);
      assert.deepEqual((await h.turn([user("hi")])).body, { reply: "Which inbox?", proposal: null });
    } finally {
      h.close();
    }
  });

  it("caps the reply at 20 000 characters", async () => {
    const h = await architectHarness();
    try {
      h.script([{ steps: [{ say: "a".repeat(25_000) }] }]);
      assert.equal(String(field((await h.turn([user("hi")])).body, "reply")).length, 20_000);
    } finally {
      h.close();
    }
  });
});

function guarded(events: unknown[]): { violation: string | null; texts: string[] } {
  const guard = new ArchitectGuard();
  const texts: string[] = [];
  for (const event of events) {
    guard.inspect(event);
    for (const parsed of parseClaudeEvent(event)) {
      if (parsed.kind === "text" && guard.verified && guard.violation === null) texts.push(parsed.text);
    }
  }
  return { violation: guard.violation, texts };
}

describe("ArchitectGuard event shapes", () => {
  const init = probeInit();
  const toolThenText = [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "text", text: "hi" }];

  for (const [what, subtype] of [["null", null], ["numeric", 1]] as const) {
    it(`checks an assistant event with a ${what} subtype by its type`, () => {
      assert.deepEqual(guarded([init, { type: "assistant", subtype, message: { content: toolThenText } }]), { violation: TOOL_MESSAGE, texts: [] });
    });
  }

  for (const subtype of [null, 1, ["init"], { init: true }]) {
    it(`stops on a system event whose subtype is ${JSON.stringify(subtype)}`, () => {
      const odd = { ...probeInit({ tools: ["Bash"] }), subtype };
      assert.deepEqual(guarded([odd, { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }]), { violation: UNCHECKED_OUTPUT, texts: [] });
      assert.deepEqual(guarded([init, odd, { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }]), { violation: UNCHECKED_OUTPUT, texts: [] });
    });
  }

  for (const event of [null, 1, "text", [], {}, { type: 7 }, { type: null }]) {
    it(`stops on an event shaped ${JSON.stringify(event)}`, () => {
      assert.equal(guarded([init, event]).violation, UNCHECKED_OUTPUT);
    });
  }

  it("lets other system subtypes and other event types through", () => {
    assert.deepEqual(guarded([init, { type: "system", subtype: "api_retry" }, { type: "system" }, { type: "result", subtype: "success" },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }]), { violation: null, texts: ["hi"] });
  });
});

describe("spawnEngine extras", () => {
  const script = (dir: string) => {
    const path = join(dir, "engine.sh");
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", tools: [] }),
      "not json",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
    ];
    writeFileSync(path, `#!/bin/sh\n${lines.map((line) => `printf '%s\\n' '${line}'`).join("\n")}\nprintf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\\n' "$HIVE_EXTRA_PROBE"\n`);
    chmodSync(path, 0o755);
    return path;
  };

  const collect = (binary: string, extras?: Parameters<typeof spawnEngine>[6]) =>
    new Promise<EngineEvent[]>((resolve) => {
      const events: EngineEvent[] = [];
      spawnEngine(binary, [], tempDir("hive-spawn-cwd-"), "", "claude-code", {
        event: (event) => events.push(event), error: () => undefined, close: () => resolve(events),
      }, extras);
    });

  it("leaves existing callers unchanged: same events, no extra env", async () => {
    const binary = script(tempDir("hive-spawn-"));
    assert.deepEqual(await collect(binary), [
      { kind: "session", id: "s1" }, { kind: "init", tools: [] }, { kind: "text", text: "hello" },
    ]);
  });

  it("passes extra env and hands each parsed JSON line to onRaw before the parsed events", async () => {
    const binary = script(tempDir("hive-spawn-"));
    const order: string[] = [];
    const raws: unknown[] = [];
    const events = await new Promise<EngineEvent[]>((resolve) => {
      const seen: EngineEvent[] = [];
      spawnEngine(binary, [], tempDir("hive-spawn-cwd-"), "", "claude-code", {
        event: (event) => {
          order.push(`event:${event.kind}`);
          seen.push(event);
        },
        error: () => undefined,
        close: () => resolve(seen),
      }, { env: { HIVE_EXTRA_PROBE: "probe" }, onRaw: (line) => {
        order.push(`raw:${String(field(line, "type"))}`);
        raws.push(line);
      } });
    });
    assert.equal(raws.length, 3);
    assert.deepEqual(order.slice(0, 3), ["raw:system", "event:session", "event:init"]);
    assert.deepEqual(events.at(-1), { kind: "text", text: "probe" });
  });
});

describe("freshArchitectCwd", () => {
  it("makes an empty 0700 dir and recreates it empty each time", () => {
    const root = tempDir("hive-architect-root-");
    const cwd = freshArchitectCwd(root);
    assert.equal(statSync(cwd).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(cwd)).mode & 0o777, 0o700);
    writeFileSync(join(cwd, "left-over"), "x");
    assert.equal(freshArchitectCwd(root), cwd);
    assert.equal(existsSync(join(cwd, "left-over")), false);
  });

  it("refuses a base dir that is a symlink", () => {
    const root = tempDir("hive-architect-root-");
    const elsewhere = tempDir("hive-architect-elsewhere-");
    mkdirSync(join(elsewhere, "target"));
    symlinkSync(join(elsewhere, "target"), join(root, "hive-architect"));
    assert.throws(() => freshArchitectCwd(root), /not a private folder/);
  });
});
