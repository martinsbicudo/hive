import { open } from "node:fs/promises";
import { LIMITS, SetupCancelled, SetupError } from "./engineSetupPins.ts";

export type SetupFetch = (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

/** Schedules `fire` after `ms`; the returned function cancels it. Tests fire these by hand. */
export interface SetupTimer {
  after(ms: number, fire: () => void): () => void;
}

export const realTimer: SetupTimer = {
  after(ms, fire) {
    const timer = setTimeout(fire, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface DownloadRequest {
  url: string;
  hosts: readonly string[];
  dest: string;
  signal: AbortSignal;
  onBytes: (received: number, total: number | null) => void;
  maxBytes?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Accepts only https on the default port, no userinfo, and a host on the provider's exact allowlist. */
export function checkedUrl(raw: string, hosts: readonly string[], base?: string): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new SetupError("The download pointed at an address Hive couldn't read, so it stopped.");
  }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) throw new SetupError(`The download tried to leave HTTPS (${url.protocol}//${url.hostname}), so Hive stopped.`);
  if (url.username !== "" || url.password !== "") throw new SetupError("The download pointed at an address with a user name in it, so Hive stopped.");
  if (!hosts.includes(url.hostname)) throw new SetupError(`The download was sent to ${url.hostname}, which isn't the vendor's own server, so Hive stopped.`);
  return url;
}

type Stop = "idle" | "total" | "cancel";

const STOP_MESSAGES: Record<Exclude<Stop, "cancel">, string> = {
  idle: "The download stalled for a minute, so Hive stopped it. Try again later.",
  total: "The download took longer than 45 minutes, so Hive stopped it. Try again on a faster connection.",
};

// A fetch that ignores its signal must still not keep a cancelled setup waiting.
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new SetupCancelled("cancelled"));
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function follow(fetcher: SetupFetch, request: DownloadRequest, signal: AbortSignal): Promise<Response> {
  let url = checkedUrl(request.url, request.hosts);
  for (let hop = 0; ; hop += 1) {
    const response = await abortable(fetcher(url.href, { redirect: "manual", signal }), signal);
    if (!REDIRECTS.has(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    if (hop >= LIMITS.maxRedirects) throw new SetupError("The download redirected too many times, so Hive stopped.");
    const location = response.headers.get("location");
    if (!location) throw new SetupError("The download redirected without saying where, so Hive stopped.");
    url = checkedUrl(location, request.hosts, url.href);
  }
}

function declaredSize(response: Response): number | null {
  const header = response.headers.get("content-length");
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  return Number(header.trim());
}

async function save(response: Response, request: DownloadRequest, onChunk: () => void): Promise<void> {
  if (response.status !== 200 || !response.body) throw new SetupError(`The vendor's server answered ${response.status}, so Hive stopped. Try again later.`);
  const total = declaredSize(response);
  const cap = Math.min(request.maxBytes ?? LIMITS.maxDownloadBytes, LIMITS.maxDownloadBytes);
  if (total !== null && total > cap) {
    await response.body.cancel().catch(() => undefined);
    throw new SetupError("The download is larger than Hive allows (1.5 GB), so it stopped.");
  }
  const reader = response.body.getReader();
  const release = () => void reader.cancel().catch(() => undefined);
  request.signal.addEventListener("abort", release, { once: true });
  if (request.signal.aborted) release();
  const file = await open(request.dest, "wx", 0o600);
  let received = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      received += next.value.byteLength;
      if (received > cap) throw new SetupError("The download is larger than Hive allows (1.5 GB), so it stopped.");
      onChunk();
      await file.write(next.value);
      request.onBytes(received, total);
    }
  } finally {
    request.signal.removeEventListener("abort", release);
    await file.close();
    await reader.cancel().catch(() => undefined);
  }
  if (request.signal.aborted) return;
  if (total !== null && received !== total) throw new SetupError("The download ended early, so Hive stopped. Try again.");
}

/** Downloads to `dest` (created exclusively, 0600), following at most three checked redirects. */
export async function download(fetcher: SetupFetch, timer: SetupTimer, request: DownloadRequest): Promise<void> {
  const inner = new AbortController();
  let stopped: Stop | null = null;
  const stop = (reason: Stop) => {
    stopped ??= reason;
    inner.abort();
  };
  const onCancel = () => stop("cancel");
  request.signal.addEventListener("abort", onCancel, { once: true });
  if (request.signal.aborted) onCancel();
  const cancelTotal = timer.after(LIMITS.totalMs, () => stop("total"));
  let cancelIdle = timer.after(LIMITS.idleMs, () => stop("idle"));
  const rearm = () => {
    cancelIdle();
    cancelIdle = timer.after(LIMITS.idleMs, () => stop("idle"));
  };
  try {
    const response = await follow(fetcher, request, inner.signal);
    await save(response, { ...request, signal: inner.signal }, rearm);
  } catch (error) {
    if (stopped === null) throw error;
  } finally {
    cancelTotal();
    cancelIdle();
    request.signal.removeEventListener("abort", onCancel);
  }
  if (stopped === "cancel") throw new SetupCancelled("cancelled");
  if (stopped !== null) throw new SetupError(STOP_MESSAGES[stopped]);
}
