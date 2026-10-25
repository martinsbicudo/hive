import type { Images } from "./computerArgs.ts";
import type { DockerRunner } from "./docker.ts";
import { log } from "./log.ts";
import type { ComputerProfile } from "./computerTypes.ts";

export interface ImageSet {
  images: Images;
  buildContexts: Images;
  profileDockerfiles?: Partial<Record<ComputerProfile, string>>;
}

export interface BuildProgress {
  image: string;
  step: number;
  steps: number;
}

export class ImageBuildError extends Error {}

const BUILD_TIMEOUT_MS = 30 * 60_000;
const builds = new Map<string, Promise<void>>();

function required(set: ImageSet, profile: ComputerProfile): { image: string; context: string; dockerfile?: string }[] {
  const computer = { image: set.images.profiles?.[profile] ?? set.images.computer, context: set.buildContexts.profiles?.[profile] ?? set.buildContexts.computer };
  const dockerfile = set.profileDockerfiles?.[profile];
  return [{ image: set.images.netns, context: set.buildContexts.netns }, dockerfile ? { ...computer, dockerfile } : computer];
}

export async function missingImages(docker: DockerRunner, set: ImageSet, profile: ComputerProfile): Promise<string[]> {
  const missing: string[] = [];
  for (const item of required(set, profile)) {
    const inspected = await docker(["image", "inspect", "--format", "{{.Id}}", item.image]);
    if (inspected.code !== 0) missing.push(item.image);
  }
  return missing;
}

// BuildKit's plain output names each Dockerfile step as "[n/m]"; that is the only progress it reports.
export function buildStep(line: string): { step: number; steps: number } | null {
  const match = /\[(?:[\w-]+ )?(\d+)\/(\d+)\]/.exec(line);
  if (!match) return null;
  const step = Number(match[1]);
  const steps = Number(match[2]);
  return steps > 0 && step <= steps ? { step, steps } : null;
}

async function build(docker: DockerRunner, image: string, context: string, dockerfile: string | undefined, onProgress?: (progress: BuildProgress) => void): Promise<void> {
  const fileArgs = dockerfile ? ["-f", `${context}/${dockerfile}`] : [];
  const result = await docker(["build", "--progress=plain", "-t", image, ...fileArgs, context], {
    timeoutMs: BUILD_TIMEOUT_MS,
    onOutput: (chunk) => {
      for (const line of chunk.split("\n")) {
        const step = buildStep(line);
        if (step) onProgress?.({ image, ...step });
      }
    },
  });
  if (result.code !== 0) throw new ImageBuildError(`building ${image} failed: ${result.stderr.trim().split("\n").pop() ?? "docker failed"}`);
}

export interface BuildHooks {
  onBuilding?: () => void;
  onProgress?: (progress: BuildProgress) => void;
}

/** Builds what is missing for the profile; concurrent callers share one build per image. */
export async function ensureImages(docker: DockerRunner, set: ImageSet, profile: ComputerProfile, hooks: BuildHooks = {}): Promise<boolean> {
  const missing = new Set(await missingImages(docker, set, profile));
  if (missing.size === 0) return false;
  hooks.onBuilding?.();
  await Promise.all(required(set, profile).filter((item) => missing.has(item.image)).map((item) => {
    const pending = builds.get(item.image) ?? build(docker, item.image, item.context, item.dockerfile, hooks.onProgress).finally(() => builds.delete(item.image));
    builds.set(item.image, pending);
    return pending;
  }));
  await pruneOldTags(docker, set.images);
  return true;
}

function currentTags(images: Images): Set<string> {
  return new Set([images.computer, images.netns, ...Object.values(images.profiles ?? {})]);
}

/** Removes this Hive's images left from earlier builds; Docker itself refuses to remove one a container uses. */
export async function pruneOldTags(docker: DockerRunner, images: Images): Promise<void> {
  const keep = currentTags(images);
  for (const repository of new Set([...keep].map((tag) => tag.split(":")[0] ?? tag))) {
    const listed = await docker(["image", "ls", repository, "--format", "{{.Repository}}:{{.Tag}}"]);
    if (listed.code !== 0) continue;
    const stale = listed.stdout.toString("utf8").split("\n").map((line) => line.trim()).filter((tag) => tag && !tag.endsWith(":<none>") && !keep.has(tag));
    for (const tag of stale) {
      const removed = await docker(["image", "rm", tag]);
      if (removed.code !== 0) log(`kept ${tag}: ${removed.stderr.trim().split("\n").pop() ?? "in use"}`);
    }
  }
}
