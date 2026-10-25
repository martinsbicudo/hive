import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ARCHITECT_ENV, ARCHITECT_MODEL, architectArguments, ArchitectGuard, UNSAFE_START } from "./architectGuard.ts";
import { ARCHITECT_PROMPT } from "./architectPrompt.ts";
import { parseProposal } from "./architectProposal.ts";
import type { Store } from "./db.ts";
import { BINARIES, type EngineEvent } from "./engines.ts";
import { HttpError } from "./httpError.ts";
import { log, oneLine } from "./log.ts";
import { findBinary } from "./process.ts";
import type { RunGate } from "./runGate.ts";
import { killSoon, spawnEngine, terminate } from "./runProcess.ts";
import { parseOr400 } from "./taskCore.ts";
import { newNonce, UnsafeContentError, wrapUntrusted } from "./trust.ts";
import { ARCHITECT_ID, type ArchitectReply, type Run } from "./types.ts";

const MAX_MESSAGES = 30;
const MAX_MESSAGE = 8000;
const MAX_TOTAL = 32_000;
const MAX_REPLY = 20_000;
const MAX_ISSUES = 1000;
const DEADLINE_MS = 120_000;
const STOPPED = "Stopped.";
const TOO_SLOW = "The Architect took too long to answer. Try again.";
const DIR_NAME = "hive-architect";

const turnInput = z
  .object({
    messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1).max(MAX_MESSAGE) }).strict()).min(1).max(MAX_MESSAGES),
  })
  .strict()
  .refine((input) => input.messages.reduce((total, message) => total + message.text.length, 0) <= MAX_TOTAL, {
    message: `the conversation is longer than ${MAX_TOTAL} characters`,
  })
  .refine((input) => input.messages.at(-1)?.role === "user", { message: "the last message must be the user's" });

type Message = z.output<typeof turnInput>["messages"][number];

export interface ArchitectDeps {
  store: Store;
  gate: Pick<RunGate, "globalBlockedReason">;
  changed: () => void;
  findEngine?: (name: string) => string | null;
  root?: string;
  deadlineMs?: number;
  nonce?: () => string;
}

export type ArchitectConfig = Pick<ArchitectDeps, "root" | "deadlineMs" | "nonce">;

interface Turn {
  child: ChildProcess | null;
  ended: string | null;
}

interface Outcome {
  reply: string;
  error: string | null;
}

export function architectDir(root: string = tmpdir()): string {
  return join(root, DIR_NAME);
}

export function freshArchitectCwd(root: string = tmpdir()): string {
  const base = architectDir(root);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stats = lstatSync(base);
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== process.getuid?.()) {
    throw new Error(`${base} is not a private folder, so the Architect didn't start`);
  }
  const cwd = join(base, "cwd");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { mode: 0o700 });
  return cwd;
}

function render(messages: readonly Message[], nonce: string): string[] {
  try {
    return messages.map((message) => wrapUntrusted(message.text, nonce, message.role === "user" ? "user" : "architect"));
  } catch (error) {
    if (error instanceof UnsafeContentError) throw new HttpError(400, "a message holds this turn's marker; change it and try again");
    throw error;
  }
}

function prompt(turns: readonly string[], note?: string): string {
  const parts = ["The conversation so far, oldest first. Write the Architect's next reply.", ...turns];
  if (note !== undefined) parts.push(`Hive: ${note}`);
  return parts.join("\n\n");
}

export class Architect {
  private readonly deps: ArchitectDeps;
  private current: Turn | null = null;

  constructor(deps: ArchitectDeps) {
    this.deps = deps;
  }

  async turn(raw: unknown): Promise<ArchitectReply> {
    const { messages } = parseOr400(turnInput, raw);
    const binary = (this.deps.findEngine ?? findBinary)(BINARIES["claude-code"]);
    if (!binary) throw new HttpError(503, "Install Claude Code to use the Architect.");
    if (this.current) throw new HttpError(409, "The Architect is already answering. Wait for it or stop it.");
    const nonce = (this.deps.nonce ?? newNonce)();
    const turns = render(messages, nonce);
    this.checkGate();
    const turn: Turn = { child: null, ended: null };
    this.current = turn;
    const deadline = setTimeout(() => this.end(turn, TOO_SLOW), this.deps.deadlineMs ?? DEADLINE_MS);
    try {
      return await this.converse(turn, binary, turns, nonce, messages.filter((message) => message.role === "user").map((message) => message.text));
    } finally {
      clearTimeout(deadline);
      this.current = null;
    }
  }

  stop(reason: string = STOPPED): boolean {
    if (!this.current) return false;
    this.end(this.current, reason);
    return true;
  }

  private async converse(turn: Turn, binary: string, turns: string[], nonce: string, userTexts: string[]): Promise<ArchitectReply> {
    const first = await this.spawn(turn, binary, prompt(turns));
    if (first.error !== null) return { reply: "", proposal: null, error: first.error };
    const result = parseProposal(first.reply, userTexts);
    if (result.kind === "none") return { reply: first.reply, proposal: null };
    if (result.kind === "valid") return { reply: first.reply, proposal: result.proposal };
    this.checkGate();
    let previous: string;
    try {
      previous = wrapUntrusted(first.reply, nonce, "architect");
    } catch {
      return { reply: first.reply, proposal: null, error: "The Architect's proposal was invalid." };
    }
    const second = await this.spawn(turn, binary, prompt([...turns, previous], `Your proposal was invalid: ${oneLine(result.issues, MAX_ISSUES)}. Send a corrected one.`));
    if (second.error !== null) return { reply: "", proposal: null, error: second.error };
    const again = parseProposal(second.reply, userTexts);
    if (again.kind === "valid") return { reply: second.reply, proposal: again.proposal };
    const why = again.kind === "invalid" ? again.issues : "it didn't send a corrected one";
    return { reply: second.reply, proposal: null, error: `The Architect's proposal was invalid: ${why}.` };
  }

  private checkGate(): void {
    const reason = this.deps.gate.globalBlockedReason();
    if (reason !== null) throw new HttpError(409, reason);
  }

  private end(turn: Turn, reason: string): void {
    if (turn.ended !== null) return;
    turn.ended = reason;
    if (turn.child) terminate(turn.child);
  }

  private spawn(turn: Turn, binary: string, input: string): Promise<Outcome> {
    if (turn.ended !== null) return Promise.resolve({ reply: "", error: turn.ended });
    const cwd = freshArchitectCwd(this.deps.root);
    const run: Run = {
      id: randomUUID(), agentId: ARCHITECT_ID, engine: "claude-code", model: ARCHITECT_MODEL, startedAt: new Date().toISOString(),
      endedAt: null, status: "running", costUsd: 0, inputTokens: 0, outputTokens: 0, error: null,
    };
    this.deps.store.insertRun(run);
    const guard = new ArchitectGuard();
    const texts: string[] = [];
    let failure: string | null = null;
    let sawResult = false;
    return new Promise((resolve) => {
      const onEvent = (event: EngineEvent): void => {
        if (guard.violation !== null) return;
        if (event.kind === "text" && guard.verified) texts.push(event.text);
        if (event.kind === "error") failure = event.message;
        if (event.kind !== "usage") return;
        sawResult = true;
        run.costUsd += event.costUsd;
        run.inputTokens += event.inputTokens;
        run.outputTokens += event.outputTokens;
        if (event.model) run.model = event.model;
        killSoon(child);
      };
      const onClose = (code: number | null, stderr: string): void => {
        const crashed = sawResult || code === 0 ? null : stderr.trim().split("\n").slice(-3).join("\n") || `exited with ${code}`;
        const error = turn.ended ?? guard.violation ?? (guard.verified ? null : UNSAFE_START) ?? failure ?? crashed;
        try {
          run.endedAt = new Date().toISOString();
          run.status = turn.ended !== null && turn.ended !== TOO_SLOW ? "stopped" : error ? "failed" : "done";
          run.error = error;
          this.deps.store.finishRun(run);
          log(oneLine(`architect run ${run.id} ${run.status} ($${run.costUsd.toFixed(4)}); plugins: ${guard.plugins.join(", ") || "none"}`));
        } finally {
          turn.child = null;
          rmSync(cwd, { recursive: true, force: true });
          this.deps.changed();
          resolve(error === null ? { reply: texts.join("\n").slice(0, MAX_REPLY), error: null } : { reply: "", error });
        }
      };
      const child = spawnEngine(binary, architectArguments(ARCHITECT_PROMPT), cwd, input, "claude-code", {
        event: onEvent,
        error: (message) => {
          failure = message;
        },
        close: onClose,
      }, {
        env: ARCHITECT_ENV,
        onRaw: (line) => {
          if (guard.inspect(line) !== null) terminate(child);
        },
      });
      turn.child = child;
    });
  }
}
