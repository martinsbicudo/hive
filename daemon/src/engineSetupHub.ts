import { loadOrCreateInstanceId } from "./paths.ts";
import { statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileRunner } from "./commandRunner.ts";
import { ensureImages } from "./computerImages.ts";
import type { ComputerService } from "./computerService.ts";
import { defaultBuildContexts, defaultImages, PROFILE_DOCKERFILES } from "./computerServiceHelpers.ts";
import type { ComputerProfile } from "./computerTypes.ts";
import type { Store } from "./db.ts";
import type { DockerRunner } from "./docker.ts";
import { realTimer } from "./engineDownload.ts";
import type { SetupEffects } from "./engineSetupFlow.ts";
import { SetupCancelled } from "./engineSetupPins.ts";
import { log } from "./log.ts";

export function freeBytes(path: string): number {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
}

/** Builds the network guard and the profile images the owner's computers use (the terminal one when there are none). */
export function imagePreparer(profiles: () => ComputerProfile[]): SetupEffects["prepareImages"] {
  return async (runner, onProgress, signal) => {
    const docker: DockerRunner = (args, options = {}) => runner(args, { ...options, signal });
    const set = { images: defaultImages(), buildContexts: defaultBuildContexts(), profileDockerfiles: { ...PROFILE_DOCKERFILES } };
    const wanted = new Set(profiles());
    if (wanted.size === 0) wanted.add("terminal");
    for (const profile of wanted) {
      if (signal.aborted) throw new SetupCancelled("cancelled");
      await ensureImages(docker, set, profile, { onProgress });
    }
  };
}

/** The real effects for the daemon; tests replace any of them. */
export function hubSetupEffects(store: Store, computers: ComputerService, overrides: Partial<SetupEffects> = {}): SetupEffects {
  return {
    fetch: (url, init) => fetch(url, init),
    run: execFileRunner,
    cacheRoot: join(homedir(), "Library", "Caches", "Hive", "setup"),
    applicationsDir: "/Applications",
    tag: loadOrCreateInstanceId().slice(0, 8),
    freeBytes,
    timer: realTimer,
    now: Date.now,
    engines: {
      active: () => computers.engines().active(),
      present: () => computers.engines().present(),
      refresh: () => computers.engines().refresh(),
      runner: (engine) => computers.engines().runner(engine),
    },
    anyActive: () => computers.anyActive(),
    paused: () => store.settings.paused(),
    prepareImages: imagePreparer(() => store.computers.resources().map((computer) => computer.profile)),
    log,
    ...overrides,
  };
}
