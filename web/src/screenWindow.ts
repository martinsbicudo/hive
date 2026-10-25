import { api, type ScreenSecrets } from "./api.ts";

const READY_MESSAGE = "hive-screen-ready";
const READY_TIMEOUT_MS = 15_000;

export class ScreenWindowError extends Error {}

function isReady(data: unknown): boolean {
  return typeof data === "object" && data !== null && "type" in data && data.type === READY_MESSAGE;
}

function readiness(child: Window): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new ScreenWindowError("The screen window didn't answer."));
    }, READY_TIMEOUT_MS);
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== child || !isReady(event.data)) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve();
    }
    window.addEventListener("message", onMessage);
  });
}

export function screenPageUrl(agentId: string): string {
  return `/screen/#agent=${encodeURIComponent(agentId)}`;
}

/** Secrets go to the child by postMessage, never in a URL, so they can't land in the browser's history. */
export async function openScreen(agentId: string): Promise<void> {
  const child = window.open(screenPageUrl(agentId), "_blank");
  if (!child) return;
  try {
    const [secrets] = await Promise.all([api.screen(agentId), readiness(child)]);
    const message: ScreenSecrets = { port: secrets.port, token: secrets.token, password: secrets.password };
    child.postMessage(message, window.location.origin);
  } catch (error) {
    child.close();
    throw error;
  }
}
