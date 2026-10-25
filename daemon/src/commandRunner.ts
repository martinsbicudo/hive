import { spawn } from "node:child_process";
import { withoutSecrets } from "./process.ts";

export interface CommandOptions {
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
}

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflowed: boolean;
}

export type CommandRunner = (file: string, args: readonly string[], options?: CommandOptions) => Promise<CommandOutput>;

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_COMMAND_OUTPUT_BYTES = 30 * 1024;

interface Collected {
  bytes: number;
  overflowed: boolean;
}

/** Appends output up to the shared cap; past it, keeps what fits and ends the command. */
function collector(into: Buffer[], cap: number, output: Collected, kill: () => void): (chunk: Buffer) => void {
  return (chunk) => {
    if (output.overflowed) return;
    const room = cap - output.bytes;
    if (chunk.length > room) {
      into.push(chunk.subarray(0, Math.max(0, room)));
      output.bytes = cap;
      output.overflowed = true;
      kill();
      return;
    }
    output.bytes += chunk.length;
    into.push(chunk);
  };
}

export const execFileRunner: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const cap = options.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES;
    const child = spawn(file, [...args], {
      shell: false,
      cwd: options.cwd,
      env: options.env ?? withoutSecrets(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const output = { bytes: 0, timedOut: false, overflowed: false };
    const timer = setTimeout(() => {
      output.timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (into: Buffer[]) => collector(into, cap, output, () => child.kill("SIGKILL"));
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut: output.timedOut,
        overflowed: output.overflowed,
      });
    });
    // the command may exit before reading stdin (EPIPE); the exit code already reports the outcome.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
