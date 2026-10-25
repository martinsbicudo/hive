import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { buildNewAgent } from "../src/agents.ts";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import { claudeArguments, type RunPlan } from "../src/engines.ts";
import { APPROVAL_TOOL, AUTO_ALLOWED_COMPUTER_TOOLS, COMPUTER_TOOLS, EXPORT_TOOL } from "../src/hiveTools.ts";
import { Hub } from "../src/hub.ts";
import { freshVirtualCwd, toolsOutsideAllowlist, VIRTUAL_DISALLOWED_TOOLS } from "../src/virtualClaude.ts";
import { ensureDirs, runtimeDir } from "../src/paths.ts";
import { fakeDocker, removeTempDirs, tar, tempDir } from "./fixtures.ts";

after(removeTempDirs);

const NOW = "2026-10-21T12:00:00.000Z";

const loosePlan: RunPlan = {
  engine: "claude-code", model: "haiku", sessionId: null, newSessionId: "new-id", systemPrompt: "You are Ana",
  workspace: "/w", folders: ["/repo"], allowedTools: ["Write", "Bash(ls:*)"], permissionMode: "accept-edits", useMySetup: true,
  mcpConfigPath: "/r/mcp.json", computer: "mac", tainted: false,
};

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function settingsOf(args: readonly string[]): unknown {
  return JSON.parse(valueAfter(args, "--settings") ?? "null");
}

describe("claude arguments for a virtual agent", () => {
  const args = claudeArguments({ ...loosePlan, computer: "virtual" });

  it("forces the restricted tool set and the hive MCP server only", () => {
    assert.ok(args.includes("--restricted"));
    assert.equal(valueAfter(args, "--tools"), "WebSearch");
    assert.equal(valueAfter(args, "--mcp-config"), "/r/mcp.json");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(valueAfter(args, "--setting-sources"), "project");
    assert.ok(args.includes("--disable-slash-commands"));
    assert.ok(args.includes("--no-chrome"));
    assert.equal(valueAfter(args, "--permission-mode"), "manual");
    assert.equal(valueAfter(args, "--permission-prompt-tool"), APPROVAL_TOOL);
  });

  it("denies the built-in tools twice, WebFetch included, and never offers WebFetch", () => {
    const disallowed = (valueAfter(args, "--disallowedTools") ?? "").split(",");
    for (const tool of ["Bash", "Read", "Write", "Edit", "WebFetch", "Agent", "Skill", "PowerShell", "LSP"]) assert.ok(disallowed.includes(tool), tool);
    assert.deepEqual(disallowed, [...VIRTUAL_DISALLOWED_TOOLS]);
    assert.ok(!(valueAfter(args, "--tools") ?? "").includes("WebFetch"));
    assert.deepEqual(settingsOf(args), {
      disableAllHooks: true, crossSessionInbound: "refuse", permissions: { deny: [...VIRTUAL_DISALLOWED_TOOLS] },
    });
  });

  it("ignores folders, accept-edits and remembered rules", () => {
    assert.ok(!args.includes("--add-dir"));
    assert.ok(!args.includes("--allowedTools") && !args.includes("--allowed-tools"));
    assert.ok(!args.includes("acceptEdits") && !args.includes("bypassPermissions") && !args.includes("--dangerously-skip-permissions"));
    assert.ok(!args.includes("/repo") && !args.includes("Bash(ls:*)"));
  });

  it("keeps the model and session handling", () => {
    assert.equal(valueAfter(args, "--model"), "haiku");
    assert.equal(valueAfter(args, "--session-id"), "new-id");
    assert.equal(valueAfter(claudeArguments({ ...loosePlan, computer: "virtual", sessionId: "old" }), "--resume"), "old");
  });

  it("leaves Mac agents' arguments as they were, except that Bash rules stay with Hive's matcher", () => {
    assert.deepEqual(claudeArguments(loosePlan), [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-prompt-tool", APPROVAL_TOOL, "--permission-mode", "acceptEdits", "--mcp-config", "/r/mcp.json",
      "--append-system-prompt", "You are Ana", "--model", "haiku", "--session-id", "new-id",
      "--allowedTools", "Write", "--add-dir", "/repo",
    ]);
  });
});

describe("init-event guard", () => {
  it("accepts web search, the computer tools and the approval tool", () => {
    assert.deepEqual(toolsOutsideAllowlist(["WebSearch", ...COMPUTER_TOOLS, APPROVAL_TOOL]), []);
    assert.deepEqual(toolsOutsideAllowlist([]), []);
  });

  it("rejects anything else, lookalikes included, and a missing list", () => {
    assert.deepEqual(toolsOutsideAllowlist(["WebSearch", "Bash", "Read", "mcp__other__x"]), ["Bash", "Read", "mcp__other__x"]);
    assert.deepEqual(toolsOutsideAllowlist(["mcp__hive__computer_runx", "mcp__hivex__computer_run", "WebFetch", "ToolSearch"]).length, 4);
    assert.deepEqual(toolsOutsideAllowlist(undefined), ["(no tool list)"]);
    assert.deepEqual(toolsOutsideAllowlist("WebSearch"), ["(no tool list)"]);
  });
});

describe("virtual working folder", () => {
  const id = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";

  it("is a fresh, empty, private folder under the temp dir", () => {
    const root = tempDir("hive-cwd-");
    const first = freshVirtualCwd(id, root);
    assert.equal(first, join(root, `hive-${id}`, "cwd"));
    writeFileSync(join(first, "CLAUDE.md"), "planted");
    const second = freshVirtualCwd(id, root);
    assert.equal(second, first);
    assert.deepEqual(readdirSync(second), []);
    assert.equal(lstatSync(second).mode & 0o777, 0o700);
  });

  it("refuses a planted symlink in place of its folder", () => {
    const root = tempDir("hive-cwd-");
    symlinkSync(tempDir("hive-elsewhere-"), join(root, `hive-${id}`));
    assert.throws(() => freshVirtualCwd(id, root), /not a private folder/);
  });
});

describe("approvals for virtual agents", () => {
  function setup() {
    const store = new Store(":memory:");
    const docker = fakeDocker((args) => args[0] === "exec" && args.includes("/bin/tar") ? { code: 0, stdout: tar([{ name: "a.txt", data: "hello" }]), stderr: "" } : null);
    const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService({ docker: () => docker.runner, stageRoot: join(tempDir("hive-stage-"), "private") }));
    const agent = buildNewAgent({ name: "Vera", computer: "virtual" }, []);
    store.insertAgent(agent, NOW);
    store.updateAgent(agent.id, { allowedTools: ["WebSearch", "Bash(ls:*)", "mcp__hive__computer_export"] }, NOW);
    return { store, hub, agent, docker };
  }

  it("auto-allows the computer tools by exact name, except export", () => {
    const { hub, agent } = setup();
    for (const tool of AUTO_ALLOWED_COMPUTER_TOOLS) assert.equal(hub.requestApproval(agent.id, tool, {}).autoAllowed, true, tool);
    for (const tool of [EXPORT_TOOL, "mcp__hive__computer_runx", "mcp__hive__computer", "Mcp__hive__computer_run", "Bash"]) {
      assert.equal(hub.requestApproval(agent.id, tool, { command: "ls" }).autoAllowed, false, tool);
    }
  });

  it("ignores stored rules and never remembers", () => {
    const { store, hub, agent } = setup();
    const search = hub.requestApproval(agent.id, "WebSearch", { query: "x" });
    assert.equal(search.autoAllowed, false);
    assert.equal(store.getApproval(search.id)?.rememberable, false);
    hub.decideApproval(search.id, true, true);
    assert.deepEqual(store.getAgent(agent.id)?.allowedTools, ["WebSearch", "Bash(ls:*)", "mcp__hive__computer_export"]);
    assert.equal(hub.requestApproval(agent.id, "Bash", { command: "ls" }).autoAllowed, false);
  });

  it("asks for every export, even after an Always allow", () => {
    const { store, hub, agent } = setup();
    for (let round = 0; round < 3; round++) {
      const request = hub.requestApproval(agent.id, EXPORT_TOOL, { path: "report.pdf" });
      assert.equal(request.autoAllowed, false);
      assert.equal(store.getApproval(request.id)?.rememberable, false);
      hub.decideApproval(request.id, true, true);
    }
    assert.deepEqual(store.getAgent(agent.id)?.allowedTools, ["WebSearch", "Bash(ls:*)", "mcp__hive__computer_export"]);
  });

  it("keeps Mac agents' remembered rules working", () => {
    const { store, hub } = setup();
    const mac = buildNewAgent({ name: "Max" }, ["Vera"]);
    store.insertAgent(mac, NOW);
    store.updateAgent(mac.id, { allowedTools: ["WebSearch"] }, NOW);
    assert.equal(hub.requestApproval(mac.id, "WebSearch", {}).autoAllowed, true);
  });

  it("deleting an agent removes its MCP config and forgets its approved exports", async () => {
    const { hub, agent, store } = setup();
    ensureDirs();
    const config = join(runtimeDir, `${agent.id}.mcp.json`);
    writeFileSync(config, "{}");
    const request = hub.requestApproval(agent.id, EXPORT_TOOL, { path: "a.txt" });
    hub.decideApproval(request.id, true, false);
    await hub.deleteAgent(agent.id);
    assert.equal(existsSync(config), false);
    store.insertAgent(agent, NOW);
    const binding = await hub.computerManagement.prepare(agent.id);
    const asked = await hub.computers.guest.exportFile(agent.id, "a.txt", binding, (snapshot) => hub.askToExport(agent.id, snapshot));
    assert.ok("approvalId" in asked && typeof asked.approvalId === "string");
    hub.computerManagement.release(binding);
    hub.shutdown();
  });

  it("deleting an agent that was switched back to the Mac still removes its old computer", async () => {
    const { hub, agent, docker } = setup();
    hub.updateAgent(agent.id, { computer: "mac" });
    await hub.deleteAgent(agent.id);
    const flat = docker.calls.map((call) => call.args.join(" "));
    assert.ok(flat.some((line) => line.startsWith("volume rm") && line.includes(`hive-home-${agent.id}`)), flat.join("\n"));
    hub.shutdown();
  });

  it("switching to the virtual computer clears the session", () => {
    const { store, hub } = setup();
    const mac = buildNewAgent({ name: "Max" }, ["Vera"]);
    store.insertAgent(mac, NOW);
    store.updateAgent(mac.id, { sessionId: "s1" }, NOW);
    hub.updateAgent(mac.id, { computer: "virtual" });
    assert.equal(store.getAgent(mac.id)?.sessionId, null);
    assert.equal(store.getAgent(mac.id)?.computer, "virtual");
    hub.shutdown();
  });
});

describe("computer column", () => {
  it("adds the column to an older database with every agent on the Mac", () => {
    const path = join(tempDir("hive-db-"), "hive.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL,
      instructions TEXT NOT NULL, avatar_style TEXT NOT NULL, avatar_seed TEXT NOT NULL,
      use_my_setup INTEGER NOT NULL, permission_mode TEXT NOT NULL, folders TEXT NOT NULL, allowed_tools TEXT NOT NULL,
      session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    legacy.prepare("INSERT INTO agents VALUES ('a1','Ana','R','claude-code','auto','','s','x',1,'ask','[]','[]',NULL,?,?)").run(NOW, NOW);
    legacy.close();
    const store = new Store(path);
    assert.equal(store.getAgent("a1")?.computer, "mac");
    store.close();
  });
});
