import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDERS } from "./engineSocket.ts";
import { findBinary, withoutSecrets } from "./process.ts";

export interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  overflowed?: boolean;
}

export interface RunOptions {
  input?: string | Buffer;
  timeoutMs?: number;
  onOutput?: (line: string) => void;
  maxStdoutBytes?: number;
  signal?: AbortSignal;
}

export type DockerRunner = (args: readonly string[], options?: RunOptions) => Promise<CommandResult>;

export class DockerUnavailableError extends Error {}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STDERR = 64 * 1024;

// Each engine's own CLI is a fallback when `docker` isn't on PATH (OrbStack doesn't need the owner's shell profile).
const CLI_FALLBACKS = [".docker/bin/docker", ".orbstack/bin/docker"];

export function findDocker(): string | null {
  const found = findBinary("docker");
  if (found) return found;
  for (const relative of CLI_FALLBACKS) {
    try {
      accessSync(join(homedir(), relative), constants.X_OK);
      return join(homedir(), relative);
    } catch {
      continue;
    }
  }
  return null;
}

export function dockerArgsForEndpoint(endpoint: string, args: readonly string[], home = homedir()): string[] {
  const known = Object.values(PROVIDERS).map((provider) => `unix://${join(home, provider.socket)}`);
  if (!known.includes(endpoint)) throw new Error("Docker endpoint must be a supported local socket");
  return ["--host", endpoint, ...args];
}

export function dockerOperationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = withoutSecrets(env);
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_API_VERSION"]) delete result[name];
  return result;
}

export function dockerRunner(binary: string, endpoint?: string): DockerRunner {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, endpoint ? dockerArgsForEndpoint(endpoint, args) : [...args], { env: endpoint ? dockerOperationEnv(process.env) : withoutSecrets(process.env), stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let stdoutBytes = 0;
      let overflowed = false;
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const abort = () => child.kill("SIGKILL");
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        if (overflowed) return;
        stdoutBytes += chunk.length;
        if (options.maxStdoutBytes !== undefined && stdoutBytes > options.maxStdoutBytes) {
          overflowed = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
        options.onOutput?.(chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8");
        options.onOutput?.(chunk.toString("utf8"));
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        reject(new DockerUnavailableError(error.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        const result: CommandResult = { code: code ?? -1, stdout: Buffer.concat(chunks), stderr };
        if (overflowed) result.overflowed = true;
        resolve(result);
      });
      // docker may exit before reading stdin (EPIPE); the exit code above already reports the outcome.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input ?? "");
    });
}
