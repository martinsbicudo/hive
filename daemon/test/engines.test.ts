import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APPROVAL_TOOL, TAINTED_MAC_DISALLOWED_TOOLS, claudeArguments, codexArguments, codexPrompt, parseClaudeEvent, parseCodexEvent, parseLine, shortenPaths, summarizeTool, type RunPlan } from "../src/engines.ts";

const plan: RunPlan = {
  engine: "claude-code", model: "sonnet", sessionId: null, newSessionId: "new-id", systemPrompt: "You are Josh",
  workspace: "/w", folders: ["/repo"], allowedTools: ["Write"], permissionMode: "ask", useMySetup: true, mcpConfigPath: "/r/mcp.json",
  computer: "mac", tainted: false,
};

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

describe("claude arguments", () => {
  it("routes every permission prompt to the Hive approval tool", () => {
    const args = claudeArguments(plan);
    assert.equal(valueAfter(args, "--permission-prompt-tool"), APPROVAL_TOOL);
    assert.equal(valueAfter(args, "--permission-mode"), "manual");
    assert.equal(valueAfter(args, "--mcp-config"), "/r/mcp.json");
  });

  it("starts a new session with a fixed id and resumes an existing one", () => {
    assert.equal(valueAfter(claudeArguments(plan), "--session-id"), "new-id");
    const resumed = claudeArguments({ ...plan, sessionId: "old" });
    assert.equal(valueAfter(resumed, "--resume"), "old");
    assert.ok(!resumed.includes("--session-id"));
  });

  it("isolates the agent from the user's setup only when asked", () => {
    assert.ok(!claudeArguments(plan).includes("--strict-mcp-config"));
    const isolated = claudeArguments({ ...plan, useMySetup: false });
    assert.ok(isolated.includes("--strict-mcp-config"));
    assert.equal(valueAfter(isolated, "--setting-sources"), "project");
  });

  it("passes model, remembered tools, folders and accept-edits mode", () => {
    const args = claudeArguments({ ...plan, permissionMode: "accept-edits" });
    assert.equal(valueAfter(args, "--model"), "sonnet");
    assert.equal(valueAfter(args, "--allowedTools"), "Write");
    assert.equal(valueAfter(args, "--add-dir"), "/repo");
    assert.equal(valueAfter(args, "--permission-mode"), "acceptEdits");
    assert.ok(!claudeArguments({ ...plan, model: null }).includes("--model"));
  });
});

describe("claude arguments for a tainted Mac run", () => {
  const cross = ["SendMessage", "ListAgents", "RemoteTrigger", "Workflow", "CronCreate", "CronDelete", "ScheduleWakeup", "PushNotification", "DesignSync"];

  it("disallows the tools that reach other sessions or schedule work outside the run", () => {
    const args = claudeArguments({ ...plan, tainted: true });
    assert.deepEqual((valueAfter(args, "--disallowedTools") ?? "").split(","), cross);
    assert.deepEqual([...TAINTED_MAC_DISALLOWED_TOOLS], cross);
    assert.equal(valueAfter(args, "--allowedTools"), "Write");
  });

  it("leaves an untainted Mac run with the user's normal tool set", () => {
    assert.ok(!claudeArguments(plan).includes("--disallowedTools"));
  });
});

describe("codex arguments", () => {
  it("runs a new session sandboxed to the workspace and reads the prompt from stdin", () => {
    const args = codexArguments({ ...plan, engine: "codex", model: null });
    assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
    assert.equal(valueAfter(args, "-C"), "/w");
    assert.ok(args.includes('sandbox_mode="workspace-write"'));
    assert.ok(args.includes('sandbox_workspace_write.writable_roots=["/repo"]'));
    assert.equal(args.at(-1), "-");
  });

  it("resumes with the thread id before the stdin marker", () => {
    const args = codexArguments({ ...plan, engine: "codex", sessionId: "thread-1", useMySetup: false });
    assert.deepEqual(args.slice(0, 2), ["exec", "resume"]);
    assert.deepEqual(args.slice(-2), ["thread-1", "-"]);
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(!args.includes("-C"));
  });

  it("sends the identity only on the first message of a session", () => {
    assert.equal(codexPrompt("ID", "hi", true), "ID\n\n---\n\nhi");
    assert.equal(codexPrompt("ID", "hi", false), "hi");
  });
});

describe("claude events", () => {
  it("reads the session, streamed text, final text and tool use", () => {
    assert.deepEqual(parseClaudeEvent({ type: "system", subtype: "init", session_id: "s1" }), [{ kind: "session", id: "s1" }, { kind: "init", tools: null }]);
    assert.deepEqual(parseClaudeEvent({ type: "system", subtype: "init", tools: ["WebSearch"] }), [{ kind: "init", tools: ["WebSearch"] }]);
    assert.deepEqual(
      parseClaudeEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }),
      [{ kind: "delta", text: "Hel" }],
    );
    const assistant = { type: "assistant", message: { content: [
      { type: "text", text: "Done" },
      { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
      { type: "tool_use", name: APPROVAL_TOOL, input: {} },
    ] } };
    assert.deepEqual(parseClaudeEvent(assistant), [{ kind: "text", text: "Done" }, { kind: "tool", name: "Bash", detail: "Bash: ls -la" }]);
  });

  it("totals cost and tokens including cache, and reports failed results", () => {
    const result = {
      type: "result", subtype: "success", is_error: false, total_cost_usd: 0.25,
      usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 },
      modelUsage: { "claude-sonnet-5-5": {} },
    };
    assert.deepEqual(parseClaudeEvent(result), [{ kind: "usage", costUsd: 0.25, inputTokens: 115, outputTokens: 7, model: "claude-sonnet-5-5" }]);
    const failed = parseClaudeEvent({ type: "result", subtype: "success", is_error: true, result: "Not logged in" });
    assert.deepEqual(failed.at(-1), { kind: "error", message: "Not logged in" });
    assert.deepEqual(parseClaudeEvent({ type: "result", subtype: "error_max_turns" }).at(-1), { kind: "error", message: "error_max_turns" });
  });

  it("ignores blank, malformed and unknown lines", () => {
    assert.deepEqual(parseLine("claude-code", ""), []);
    assert.deepEqual(parseLine("claude-code", "{not json"), []);
    assert.deepEqual(parseLine("claude-code", JSON.stringify({ type: "user" })), []);
  });
});

describe("codex events", () => {
  it("reads thread, messages, commands, file changes, usage and failures", () => {
    assert.deepEqual(parseCodexEvent({ type: "thread.started", thread_id: "t1" }), [{ kind: "session", id: "t1" }]);
    assert.deepEqual(parseCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "hi" } }), [{ kind: "text", text: "hi" }]);
    assert.deepEqual(
      parseCodexEvent({ type: "item.started", item: { type: "command_execution", command: "npm test" } }),
      [{ kind: "tool", name: "Shell", detail: "Shell: npm test" }],
    );
    assert.deepEqual(
      parseCodexEvent({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts" }, { path: "b.ts" }] } }),
      [{ kind: "tool", name: "Edit", detail: "Edit: a.ts, b.ts" }],
    );
    assert.deepEqual(
      parseCodexEvent({ type: "turn.completed", usage: { input_tokens: 50, output_tokens: 5 } }),
      [{ kind: "usage", costUsd: 0, inputTokens: 50, outputTokens: 5, model: null }],
    );
    assert.deepEqual(parseCodexEvent({ type: "turn.failed", error: { message: "boom" } }), [{ kind: "error", message: "boom" }]);
  });
});

describe("tool summaries", () => {
  it("prefers the most telling field and truncates long values", () => {
    assert.equal(summarizeTool("Write", { file_path: "/a.txt", content: "x" }), "Write: /a.txt");
    assert.equal(summarizeTool("Custom", { a: 1 }), 'Custom: {"a":1}');
    assert.equal(summarizeTool("Empty", {}), "Empty");
    const long = summarizeTool("Bash", { command: "x".repeat(500) });
    assert.ok(long.length <= "Bash: ".length + 160);
    assert.ok(long.endsWith("…"));
  });
});

describe("path shortening", () => {
  it("shows the agent workspace and home folder briefly", () => {
    assert.equal(shortenPaths("Write: /h/.hive/agents/a/workspace/x.txt", "/h/.hive/agents/a/workspace", "/h"), "Write: workspace/x.txt");
    assert.equal(shortenPaths("Read: /h/Projects/app/README.md", "/w", "/h"), "Read: ~/Projects/app/README.md");
  });
});
