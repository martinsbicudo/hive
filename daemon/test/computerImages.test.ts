import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildStep, ensureImages, pruneOldTags, type BuildProgress, type ImageSet } from "../src/computerImages.ts";
import { contextHash, defaultBuildContexts, defaultImages } from "../src/computerServiceHelpers.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import { VERSION } from "../src/version.ts";
import { removeTempDirs, tempDir, writeWhole } from "./fixtures.ts";

after(removeTempDirs);

const done = (stdout = "", code = 0, stderr = ""): CommandResult => ({ code, stdout: Buffer.from(stdout), stderr });

const SET: ImageSet = {
  images: { computer: "hive/computer:1-aaaa", netns: "hive/netns:1-bbbb", profiles: { terminal: "hive/computer:1-aaaa-terminal" } },
  buildContexts: { computer: "/ctx/computer", netns: "/ctx/netns", profiles: { terminal: "/ctx/computer" } },
  profileDockerfiles: { terminal: "Dockerfile.terminal" },
};

function engine(present: Set<string>, listed: string[] = [], inUse = new Set<string>()) {
  const calls: string[][] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runner: DockerRunner = async (args, options = {}) => {
    calls.push([...args]);
    if (args[0] === "image" && args[1] === "inspect") return present.has(args.at(-1) ?? "") ? done("sha256:1") : done("", 1, "No such image");
    if (args[0] === "build") {
      await gate;
      options.onOutput?.("#5 [2/4] RUN apt-get update\n#6 [4/4] COPY hive-shot /usr/local/bin/\n");
      present.add(args[args.indexOf("-t") + 1] ?? "");
      return done();
    }
    if (args[0] === "image" && args[1] === "ls") return done(listed.filter((tag) => tag.startsWith(`${args[2]}:`)).join("\n"));
    if (args[0] === "image" && args[1] === "rm") return inUse.has(args[2] ?? "") ? done("", 1, "image is being used by stopped container") : done();
    return done();
  };
  return { calls, runner, release };
}

describe("computer images", () => {
  it("reads build progress from BuildKit's step counters only", () => {
    assert.deepEqual(buildStep("#7 [3/9] RUN apt-get install -y chromium"), { step: 3, steps: 9 });
    assert.deepEqual(buildStep("#4 [stage-1 2/5] COPY . ."), { step: 2, steps: 5 });
    assert.equal(buildStep("#7 DONE 2.1s"), null);
    assert.equal(buildStep("#3 [internal] load metadata"), null);
    assert.equal(buildStep("[9/3] impossible"), null);
  });

  it("builds nothing when the profile's images are present", async () => {
    const fake = engine(new Set(["hive/netns:1-bbbb", "hive/computer:1-aaaa-terminal"]));
    let building = false;
    assert.equal(await ensureImages(fake.runner, SET, "terminal", { onBuilding: () => { building = true; } }), false);
    assert.equal(building, false);
    assert.ok(!fake.calls.some((call) => call[0] === "build"));
  });

  it("builds only the missing image with its own Dockerfile and reports each step", async () => {
    const fake = engine(new Set(["hive/netns:1-bbbb"]));
    const steps: BuildProgress[] = [];
    const running = ensureImages(fake.runner, SET, "terminal", { onProgress: (progress) => steps.push(progress) });
    fake.release();
    assert.equal(await running, true);
    const builds = fake.calls.filter((call) => call[0] === "build");
    assert.deepEqual(builds, [["build", "--progress=plain", "-t", "hive/computer:1-aaaa-terminal", "-f", "/ctx/computer/Dockerfile.terminal", "/ctx/computer"]]);
    assert.deepEqual(steps.map((step) => `${step.step}/${step.steps}`), ["2/4", "4/4"]);
  });

  it("shares one build between callers that start together", async () => {
    const fake = engine(new Set(["hive/computer:1-aaaa-terminal"]));
    const both = Promise.all([ensureImages(fake.runner, SET, "terminal"), ensureImages(fake.runner, SET, "terminal")]);
    await new Promise((resolve) => setImmediate(resolve));
    fake.release();
    await both;
    assert.equal(fake.calls.filter((call) => call[0] === "build").length, 1);
  });

  it("removes older tags of Hive's images but keeps the current ones and any in use", async () => {
    const listed = ["hive/computer:1-aaaa", "hive/computer:1-aaaa-terminal", "hive/computer:0.1.0", "hive/computer:0.1.0-browser", "hive/netns:1-bbbb", "hive/netns:0.1.0", "hive/netns:<none>"];
    const fake = engine(new Set(), listed, new Set(["hive/computer:0.1.0-browser"]));
    await pruneOldTags(fake.runner, SET.images);
    const removed = fake.calls.filter((call) => call[1] === "rm").map((call) => call[2]);
    assert.deepEqual(removed.sort(), ["hive/computer:0.1.0", "hive/computer:0.1.0-browser", "hive/netns:0.1.0"]);
    assert.ok(!fake.calls.some((call) => call.includes("-f") || call.includes("--force")));
  });

  it("tags images with the version and a hash that changes with any file of the build context", () => {
    const dir = tempDir("hive-context-");
    writeWhole(join(dir, "Dockerfile"), "FROM scratch\n");
    writeWhole(join(dir, "firewall.sh"), "echo one\n");
    const first = contextHash(dir);
    assert.match(first, /^[0-9a-f]{8}$/);
    assert.equal(contextHash(dir), first);
    writeWhole(join(dir, "firewall.sh"), "echo two\n");
    assert.notEqual(contextHash(dir), first);
    const images = defaultImages(defaultBuildContexts());
    assert.match(images.netns, new RegExp(`^hive/netns:${VERSION.replace(/\./g, "\\.")}-[0-9a-f]{8}$`));
    assert.equal(images.profiles?.terminal, `${images.computer}-terminal`);
  });
});
