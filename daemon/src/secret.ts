import type { Readable } from "node:stream";

export const MIN_SECRET_LENGTH = 32;
const STDIN_TIMEOUT_MS = 10_000;

export function readFirstLine(stream: Readable, timeoutMs: number = STDIN_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const finish = (error: Error | null): void => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.pause();
      if (error) reject(error);
      else resolve(buffered.split("\n")[0] ?? "");
    };
    const onData = (chunk: Buffer | string): void => {
      buffered += chunk.toString();
      if (buffered.includes("\n")) finish(null);
    };
    const onEnd = (): void => finish(null);
    const onError = (error: Error): void => finish(error);
    const timer = setTimeout(() => finish(new Error("timed out waiting for the secret on stdin")), timeoutMs);
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

export async function readUiSecret(stream: Readable, timeoutMs?: number): Promise<string> {
  const secret = (await readFirstLine(stream, timeoutMs)).trim();
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`the secret on stdin must be at least ${MIN_SECRET_LENGTH} characters`);
  return secret;
}
