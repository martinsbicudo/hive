import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { parseLine, shortenPaths, type EngineEvent } from "./engines.ts";
import { log } from "./log.ts";
import { agentWorkspacePath } from "./paths.ts";
import { childEnvironment, lineSplitter } from "./process.ts";
import type { ActiveRun } from "./runState.ts";
import type { Engine } from "./types.ts";
import { toolsOutsideAllowlist } from "./virtualClaude.ts";

const KILL_GRACE_MS = 2000;
const STDERR_LIMIT = 4000;
const GUARD_MESSAGE = "Hive stopped this run: Claude Code offered tools a virtual agent must not have";

export interface EngineStream {
  event(event: EngineEvent): void;
  error(message: string): void;
  close(code: number | null, stderr: string): void;
}

export interface EventSink {
  delta(agentId: string, text: string): void;
  changed(): void;
  revoke(token: string): void;
}

export function killGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    log(`couldn't stop process ${child.pid}: ${String(error)}`);
  }
}

export function killSoon(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  setTimeout(() => killGroup(child, signal), KILL_GRACE_MS).unref();
}

export function terminate(child: ChildProcess): void {
  killGroup(child);
  killSoon(child, "SIGKILL");
}

export interface SpawnExtras {
  env?: Record<string, string>;
  onRaw?: (line: unknown) => void;
}

function rawJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function spawnEngine(
  binary: string, args: readonly string[], cwd: string, input: string, engine: Engine, stream: EngineStream, extras: SpawnExtras = {},
): ChildProcess {
  const child = spawn(binary, args, { cwd, env: childEnvironment(extras.env), detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stdout?.on("data", lineSplitter((line) => {
    const raw = extras.onRaw && line.trim() ? rawJson(line) : undefined;
    if (raw !== undefined) extras.onRaw?.(raw);
    for (const event of parseLine(engine, line)) stream.event(event);
  }));
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
  });
  child.on("error", (error) => stream.error(error.message));
  child.on("close", (code) => stream.close(code, stderr));
  // the engine may exit before reading its prompt (EPIPE); its exit code and stderr already report the failure.
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(input);
  return child;
}

function trip(active: ActiveRun, outside: readonly string[], sink: EventSink): void {
  if (active.error?.startsWith(GUARD_MESSAGE)) return;
  active.error = `${GUARD_MESSAGE} (${outside.join(", ")}).`;
  if (active.token) sink.revoke(active.token);
  killGroup(active.child);
}

export function handleEvent(active: ActiveRun, event: EngineEvent, sink: EventSink): void {
  const { agentId } = active.run;
  if (active.stopped) return;
  if (active.virtual && !active.verified && event.kind === "tool") return trip(active, ["a tool call before the tool list"], sink);
  switch (event.kind) {
    case "init": {
      log(`run ${active.run.id} tools: ${(event.tools ?? []).join(", ")}`);
      if (!active.virtual) return;
      const outside = toolsOutsideAllowlist(event.tools);
      if (outside.length > 0) return trip(active, outside, sink);
      active.verified = true;
      return;
    }
    case "session":
      if (active.run.engine !== "codex") return;
      active.sessionId = event.id;
      active.job.saveSession(event.id);
      return;
    case "delta":
      active.activity = "Writing…";
      if (active.entry.kind === "chat") sink.delta(agentId, event.text);
      return;
    case "text":
      active.job.reply(event.text, active.context);
      return;
    case "tool": {
      const detail = shortenPaths(event.detail, agentWorkspacePath(agentId), homedir());
      active.activity = detail;
      active.job.tool(detail);
      sink.changed();
      return;
    }
    case "usage":
      active.sawResult = true;
      active.run.costUsd += event.costUsd;
      active.run.inputTokens += event.inputTokens;
      active.run.outputTokens += event.outputTokens;
      if (event.model) active.run.model = event.model;
      killSoon(active.child);
      return;
    case "error":
      active.error = event.message;
      return;
  }
}
