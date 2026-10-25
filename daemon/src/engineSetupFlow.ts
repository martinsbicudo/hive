import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "./commandRunner.ts";
import type { EngineBindings } from "./computerEngines.ts";
import type { BuildProgress } from "./computerImages.ts";
import type { DockerRunner } from "./docker.ts";
import { download, type SetupFetch, type SetupTimer } from "./engineDownload.ts";
import type { Engine } from "./engineAttest.ts";
import { attach, detach, inspectRoot, installApp } from "./engineInstall.ts";
import { LIMITS, SetupCancelled, SetupError, tempPrefix, TOOLS, type SetupPin } from "./engineSetupPins.ts";
import type { SetupStep } from "./engineSetupStatus.ts";
import { checkMac, isRealDirectory, quarantine, verifyApp, verifyDmg } from "./engineVerify.ts";

export interface SetupEffects {
  fetch: SetupFetch;
  run: CommandRunner;
  cacheRoot: string;
  applicationsDir: string;
  tag: string;
  freeBytes: (path: string) => number;
  timer: SetupTimer;
  now: () => number;
  engines: Pick<EngineBindings, "active" | "refresh" | "runner" | "present">;
  anyActive: () => boolean;
  paused: () => boolean;
  prepareImages: (runner: DockerRunner, onProgress: (progress: BuildProgress) => void, signal: AbortSignal) => Promise<void>;
  log: (line: string) => void;
}

export interface FlowContext {
  effects: SetupEffects;
  pin: SetupPin;
  signal: AbortSignal;
  report: (step: SetupStep, fraction: number, detail: string) => void;
  cancellable: (value: boolean) => void;
}

const MB = 1024 * 1024;
const GUESSED_BYTES = 600 * MB;

function ensureCacheRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const entry = lstatSync(root);
  if (!entry.isDirectory() || entry.uid !== process.getuid?.()) throw new SetupError("Hive's setup folder isn't a private folder of yours, so it stopped.");
  chmodSync(root, 0o700);
}

async function fetchAndVerify(context: FlowContext, tmp: string, mountPoint: string): Promise<string> {
  const { effects, pin, signal, report } = context;
  const name = pin.spec.name;
  report("check", 0, "Checking this Mac.");
  const arch = await checkMac({ run: effects.run, freeBytes: effects.freeBytes, signal }, pin, effects.cacheRoot, effects.applicationsDir);
  report("download", 0, `Downloading ${name} from its vendor.`);
  const dmg = join(tmp, `${pin.appName.replace(/\.app$/, "")}.dmg`);
  await download(effects.fetch, effects.timer, {
    url: pin.urls[arch], hosts: pin.hosts, dest: dmg, signal,
    onBytes: (received, total) => report("download", received / (total ?? Math.max(GUESSED_BYTES, received * 1.05)),
      `Downloading ${name}: ${Math.round(received / MB)}${total === null ? "" : ` of ${Math.round(total / MB)}`} MB.`),
  });
  await quarantine(effects.run, dmg, effects.now() / 1000, signal);
  report("verify", 0, `Checking ${name}'s signature and Apple's notarization.`);
  await verifyDmg(effects.run, dmg, pin, signal);
  report("verify", 0.4, `Opening the ${name} disk image (read-only).`);
  await attach(effects.run, dmg, mountPoint, signal);
  const app = inspectRoot(mountPoint, pin);
  report("verify", 0.6, `Checking ${pin.appName} inside the disk image.`);
  await verifyApp(effects.run, app, pin, { strict: true, gatekeeper: true, bundle: true }, signal);
  return app;
}

/** Check, download, verify and install; the image is always detached and the temp folder removed before returning. */
export async function installFlow(context: FlowContext): Promise<void> {
  const { effects, pin } = context;
  ensureCacheRoot(effects.cacheRoot);
  const tmp = mkdtempSync(join(effects.cacheRoot, tempPrefix(effects.tag)));
  const mountPoint = join(tmp, "mnt");
  try {
    const app = await fetchAndVerify(context, tmp, mountPoint);
    context.report("install", 0, `Copying ${pin.appName} into ${effects.applicationsDir}.`);
    await installApp({ run: effects.run, tag: effects.tag, signal: context.signal, committing: () => context.cancellable(false) }, app, effects.applicationsDir, pin);
    context.report("install", 1, `${pin.appName} is in ${effects.applicationsDir}.`);
  } finally {
    await release(effects, tmp, mountPoint);
  }
}

// A mounted volume has its own device number; a temp folder still holding one is left for the next daemon start.
async function release(effects: SetupEffects, tmp: string, mountPoint: string): Promise<void> {
  const deviceOf = (path: string) => {
    try {
      return lstatSync(path).dev;
    } catch {
      return null;
    }
  };
  if (deviceOf(mountPoint) !== null) await detach(effects.run, mountPoint);
  const device = deviceOf(mountPoint);
  if (device !== null && device !== deviceOf(tmp)) {
    effects.log(`engine setup: couldn't detach ${mountPoint}; it is retried when the daemon starts`);
    return;
  }
  rmSync(tmp, { recursive: true, force: true });
}

/** Start (E6) runs the installed-app requirement check first; the image check is the install's job. */
export async function checkInstalled(context: FlowContext, app: string): Promise<void> {
  context.report("check", 0, `Checking ${context.pin.appName}.`);
  if (!isRealDirectory(app)) throw new SetupError(`${app} isn't an app folder, so Hive won't open it.`);
  await verifyApp(context.effects.run, app, context.pin, { strict: false, gatekeeper: true, bundle: false }, context.signal);
}

interface Wake {
  now?: () => void;
}

function nap(timer: SetupTimer, ms: number, signal: AbortSignal, wake: Wake): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      cancel();
      signal.removeEventListener("abort", onAbort);
      wake.now = undefined;
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new SetupCancelled("cancelled"));
    const cancel = timer.after(ms, () => finish());
    wake.now = () => finish();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type Started = { kind: "ready"; engine: Engine } | { kind: "other"; detail: string };

function firstRunNote(pin: SetupPin): string {
  const migrate = pin.spec.id === "orbstack" ? ", its offer to migrate from Docker Desktop" : "";
  return `${pin.spec.name}'s own windows (welcome or terms, the password for its helper${migrate}) are yours to answer; Hive never answers them.`;
}

/** Opens the app and waits for its engine to attest; a different selected Docker context is reported, never changed. */
export async function launchAndWait(context: FlowContext, app: string): Promise<Started> {
  const { effects, pin, signal } = context;
  const name = pin.spec.name;
  context.report("start", 0, `Opening ${name}. ${firstRunNote(pin)}`);
  const opened = await effects.run(TOOLS.open, [app], { timeoutMs: 60_000, signal });
  if (opened.code !== 0) throw new SetupError(`macOS couldn't open ${pin.appName}.`);
  const wake: Wake = {};
  let expired = false;
  const cancelDeadline = effects.timer.after(LIMITS.startWaitMs, () => {
    expired = true;
    wake.now?.();
  });
  try {
    for (let polls = 0, mismatches = 0; ; polls += 1) {
      effects.engines.refresh();
      const [active, present] = await Promise.all([effects.engines.active(), effects.engines.present()]);
      if (active.status === "ready" && active.engine.provider === pin.spec.id) return { kind: "ready", engine: active.engine };
      mismatches = present.some((engine) => engine.provider === pin.spec.id) ? mismatches + 1 : 0;
      if (mismatches >= 2) {
        const selected = active.status === "ready" ? `points at ${active.engine.name}` : `isn't ${name}'s`;
        return { kind: "other", detail: `${name} is running, but the selected Docker context ${selected}. Hive follows that selection and doesn't change it; switch it to ${name} when you want Hive to use ${name}.` };
      }
      if (expired) throw new SetupError(`${name} didn't get ready within 10 minutes. If one of its windows is waiting for you, answer it and press Start.`);
      context.report("start", (polls * LIMITS.pollMs) / LIMITS.startWaitMs, `Waiting for ${name} to start. ${firstRunNote(pin)}`);
      await nap(effects.timer, LIMITS.pollMs, signal, wake);
    }
  } finally {
    cancelDeadline();
  }
}

export async function prepare(context: FlowContext, engine: Engine): Promise<void> {
  context.report("images", 0, "Preparing Hive's images. The first time takes a few minutes.");
  let best = 0;
  await context.effects.prepareImages(context.effects.engines.runner(engine), (progress) => {
    best = Math.max(best, progress.step / progress.steps);
    context.report("images", best, `Preparing ${progress.image}: step ${progress.step} of ${progress.steps}.`);
  }, context.signal);
}
