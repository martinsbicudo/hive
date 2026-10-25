import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentPatch, buildNewAgent, identityPrompt, pickName, SUGGESTED_NAMES, ValidationError } from "../src/agents.ts";
import { matchesRule, ruleFor } from "../src/approvals.ts";
import { effortFor, resolveModel } from "../src/models.ts";
import { summarizeUsage, usageWindows } from "../src/usage.ts";
import type { Run } from "../src/types.ts";

describe("remembered approvals", () => {
  it("remembers safe shell commands by program and known tools by name", () => {
    assert.equal(ruleFor("Bash", { command: "ls -la src" }), "Bash(ls:*)");
    assert.equal(ruleFor("Write", { file_path: "/a" }), "Write");
  });

  it("offers rules only for allowlisted read-only programs", () => {
    for (const program of ["pwd", "cat", "grep", "jq", "realpath"]) assert.equal(ruleFor("Bash", { command: `${program} x` }), `Bash(${program}:*)`);
  });

  it("never offers a rule for programs outside the allowlist", () => {
    const programs = [
      "git", "gh", "osascript", "python3", "npm", "env", "sh", "nice", "tar", "less", "xcrun", "caffeinate", "script",
      "sandbox-exec", "rg", "sort", "tree", "file", "/bin/ls", "./ls", "FOO=1", ".",
    ];
    for (const program of programs) {
      assert.equal(ruleFor("Bash", { command: `${program} status` }), null, program);
    }
  });

  it("never offers or matches a rule for commands that run or write through flags", () => {
    const commands = [
      "rg --pre=sh x f", "sort --compress-program sh f", "tree -o f", "file -C", "grep -o x f", "grep -ox f",
      "jq --output x f", "cat --files-from=list", "ls --exec=sh", "ls -exec sh", "head --pre-glob=x f",
    ];
    for (const command of commands) assert.equal(ruleFor("Bash", { command }), null, command);
    for (const command of ["grep -o x f", "grep -ox f", "jq --output x f", "cat --files-from=list", "ls -exec sh"]) {
      const program = command.split(" ")[0] ?? "";
      assert.ok(!matchesRule(`Bash(${program}:*)`, "Bash", { command }), command);
    }
    assert.ok(matchesRule("Bash(grep:*)", "Bash", { command: "grep -rn x src" }));
    assert.ok(matchesRule("Bash(ls:*)", "Bash", { command: "ls -la src" }));
  });

  it("never offers a rule for unknown or model-supplied tool names", () => {
    assert.equal(ruleFor("mcp__x__y", {}), null);
    assert.equal(ruleFor("Agent", {}), null);
    assert.equal(ruleFor("Bash", {}), null);
    assert.equal(ruleFor("Bash", { command: "ls\nrm -rf ~" }), null);
  });

  it("matches only the same program over a strict character set", () => {
    assert.ok(matchesRule("Bash(ls:*)", "Bash", { command: "ls -la src" }));
    assert.ok(matchesRule("Bash(ls:*)", "Bash", { command: "ls" }));
    assert.ok(!matchesRule("Bash(ls:*)", "Bash", { command: "lsof" }));
    assert.ok(!matchesRule("Bash(ls:*)", "Write", { command: "ls" }));
    assert.ok(matchesRule("Write", "Write", {}));
    assert.ok(!matchesRule("Write", "Edit", {}));
  });

  it("rejects commands with control characters, quoting or shell syntax", () => {
    const attacks = [
      "ls\nrm -rf ~", "ls\rrm -rf ~", "ls\t-la", "ls 'a b'", 'ls "a"', "ls a\\ b", "ls !!", "ls $(whoami)",
      "ls `whoami`", "ls; rm -rf ~", "ls && id", "ls | sh", "ls > out", "ls ~", "ls *", "ls {a,b}", "ls #x",
    ];
    for (const command of attacks) assert.ok(!matchesRule("Bash(ls:*)", "Bash", { command }), JSON.stringify(command));
  });

  it("ignores stored rules for programs outside the allowlist", () => {
    for (const program of ["git", "gh", "osascript", "python3", "npm", "env", "nice", "tar", "less", "xcrun", "caffeinate", "script", "sandbox-exec"]) {
      assert.ok(!matchesRule(`Bash(${program}:*)`, "Bash", { command: `${program} status` }), program);
    }
    assert.ok(!matchesRule("Bash(/bin/ls:*)", "Bash", { command: "/bin/ls" }));
  });
});

describe("automatic model choice", () => {
  it("uses the deep model for reviews and long requests", () => {
    assert.equal(effortFor("Please review PR 42"), "deep");
    assert.equal(effortFor("Faz a revisão desse PR"), "deep");
    assert.equal(effortFor("x".repeat(1300)), "deep");
  });

  it("uses the light model for short checks and the standard one otherwise", () => {
    assert.equal(effortFor("Any new messages?"), "light");
    assert.equal(effortFor("Write a friendly reply to Ana thanking her for the intro"), "standard");
  });

  it("maps effort to Claude models and respects a fixed model", () => {
    assert.equal(resolveModel("claude-code", "auto", "review this"), "opus");
    assert.equal(resolveModel("claude-code", "auto", "check status"), "haiku");
    assert.equal(resolveModel("claude-code", "haiku", "review this"), "haiku");
    assert.equal(resolveModel("codex", "auto", "review this"), null);
  });
});

describe("new agents", () => {
  it("fills in a free name, a role, Claude Code and Auto when nothing is given", () => {
    const agent = buildNewAgent({}, ["Josh"]);
    assert.ok(SUGGESTED_NAMES.includes(agent.name));
    assert.notEqual(agent.name, "Josh");
    assert.equal(agent.role, "Personal Assistant");
    assert.equal(agent.engine, "claude-code");
    assert.equal(agent.model, "auto");
    assert.equal(agent.permissionMode, "ask");
    assert.ok(agent.avatarSeed.startsWith(agent.name));
  });

  it("keeps what the user typed", () => {
    const agent = buildNewAgent({ name: " Josh ", role: "Software Engineer", engine: "codex", folders: ["/repo"] }, []);
    assert.equal(agent.name, "Josh");
    assert.equal(agent.role, "Software Engineer");
    assert.equal(agent.engine, "codex");
    assert.deepEqual(agent.folders, ["/repo"]);
  });

  it("rejects invalid input with a clear message", () => {
    assert.throws(() => buildNewAgent({ engine: "gpt" }, []), ValidationError);
    assert.throws(() => buildNewAgent({ model: "opus", engine: "codex" }, []), /isn't available for codex/);
    assert.throws(() => buildNewAgent({ folders: ["relative/path"] }, []), /absolute paths/);
    assert.throws(() => buildNewAgent({ name: "x".repeat(41) }, []), /longer than 40/);
    assert.throws(() => buildNewAgent({ avatarStyle: "clipart" }, []), /unknown avatar style/);
  });

  it("numbers a name once every suggestion is taken", () => {
    assert.equal(pickName([...SUGGESTED_NAMES], () => 0), `${SUGGESTED_NAMES[0]} 2`);
    assert.equal(pickName([...SUGGESTED_NAMES, `${SUGGESTED_NAMES[0]} 2`], () => 0), `${SUGGESTED_NAMES[0]} 3`);
  });

  it("drops the session when the engine changes", () => {
    assert.equal(buildAgentPatch({ engine: "codex" }, { engine: "claude-code", computer: "mac", connectors: [] }).sessionId, null);
    assert.equal(buildAgentPatch({ engine: "claude-code" }, { engine: "claude-code", computer: "mac", connectors: [] }).sessionId, undefined);
    assert.equal(buildAgentPatch({ model: "auto" }, { engine: "codex", computer: "mac", connectors: [] }).model, "auto");
  });

  it("works on the Mac unless told otherwise, and drops the session when the computer changes", () => {
    assert.equal(buildNewAgent({}, []).computer, "mac");
    assert.equal(buildNewAgent({ computer: "virtual" }, []).computer, "virtual");
    const mac = { engine: "claude-code", computer: "mac", connectors: [] } as const;
    assert.equal(buildAgentPatch({ computer: "virtual" }, mac).sessionId, null);
    assert.equal(buildAgentPatch({ computer: "mac" }, { engine: "claude-code", computer: "virtual", connectors: [] }).sessionId, null);
    assert.equal(buildAgentPatch({ computer: "mac" }, mac).sessionId, undefined);
  });

  it("rejects a virtual computer for Codex, connectors on one, and unknown modes", () => {
    assert.throws(() => buildNewAgent({ engine: "codex", computer: "virtual" }, []), /Claude Code only/);
    assert.throws(() => buildAgentPatch({ computer: "virtual" }, { engine: "codex", computer: "mac", connectors: [] }), /Claude Code only/);
    assert.throws(() => buildAgentPatch({ engine: "codex" }, { engine: "claude-code", computer: "virtual", connectors: [] }), /Claude Code only/);
    assert.throws(() => buildNewAgent({ computer: "virtual", connectors: ["gmail"] }, []), /connectors/);
    assert.doesNotThrow(() => buildAgentPatch({ connectors: [] }, { engine: "claude-code", computer: "virtual", connectors: [] }));
    assert.throws(() => buildNewAgent({ computer: "cloud" }, []), /mac or virtual/);
    assert.doesNotThrow(() => buildNewAgent({ engine: "codex", computer: "mac" }, []));
  });

  it("introduces the agent by name and role and appends user instructions", () => {
    const prompt = identityPrompt({ name: "Josh", role: "Software Engineer", instructions: "Use pnpm." });
    assert.match(prompt, /You are Josh, a Software Engineer/);
    assert.match(prompt, /Instructions from the user:\nUse pnpm\.$/);
    assert.doesNotMatch(identityPrompt({ name: "A", role: "B", instructions: "" }), /Instructions from the user/);
  });
});

describe("usage", () => {
  const now = new Date(2026, 9, 21, 15, 0);
  const windows = usageWindows(now);
  const run = (engine: Run["engine"], startedAt: Date, costUsd: number): Run => ({
    id: String(Math.random()), agentId: "a", engine, model: "m", startedAt: startedAt.toISOString(), endedAt: null,
    status: "done", costUsd, inputTokens: 10, outputTokens: 5, error: null,
  });

  it("splits spend into today, the last 7 days and this month", () => {
    const runs = [run("claude-code", new Date(2026, 9, 21, 9), 1), run("claude-code", new Date(2026, 9, 17), 2), run("claude-code", new Date(2026, 9, 2), 4)];
    const [claude] = summarizeUsage(runs, new Map([["claude-code", 1]]), new Map(), windows);
    assert.deepEqual(
      { today: claude?.todayUsd, week: claude?.weekUsd, month: claude?.monthUsd, tokens: claude?.todayTokens },
      { today: 1, week: 3, month: 7, tokens: 15 },
    );
  });

  it("shows only engines that have agents", () => {
    const usage = summarizeUsage([run("codex", now, 0)], new Map([["claude-code", 2]]), new Map([["claude-code", 1]]), windows);
    assert.deepEqual(usage.map((entry) => [entry.engine, entry.agents, entry.activeRuns]), [["claude-code", 2, 1]]);
  });

  it("counts the last 7 days including today", () => {
    assert.equal(new Date(windows.weekStart).getDate(), 15);
    assert.equal(new Date(windows.monthStart).getDate(), 1);
  });
});
