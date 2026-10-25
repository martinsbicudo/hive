import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLeftovers } from "../src/engineSetupCleanup.ts";
import { attach, inspectRoot, installApp } from "../src/engineInstall.ts";
import { LIMITS, pinFor, SetupError } from "../src/engineSetupPins.ts";
import { bundleBytes, checkMac, verifyApp, verifyDmg } from "../src/engineVerify.ts";
import { World } from "./engineSetupFixtures.ts";
import { removeTempDirs } from "./fixtures.ts";

const ORB = pinFor("orbstack");
const signal = new AbortController().signal;

function mounted(world: World): string {
  const mount = join(world.root, "mnt");
  mkdirSync(mount);
  world.layout(mount);
  return mount;
}

const TAG = "0b6f3c1e";

describe("engine install checks", () => {
  after(() => removeTempDirs());

  it("pins the vendor origins, apps and teams", () => {
    assert.deepEqual(ORB.hosts, ["orbstack.dev", "cdn-updates.orbstack.dev"]);
    assert.equal(ORB.urls.arm64, "https://orbstack.dev/download/stable/latest/arm64");
    assert.equal(ORB.appName, "OrbStack.app");
    const docker = pinFor("docker-desktop");
    assert.deepEqual(docker.hosts, ["desktop.docker.com"]);
    assert.equal(docker.urls.amd64, "https://desktop.docker.com/mac/main/amd64/Docker.dmg");
    assert.equal(docker.spec.team, "9BNSXJN65R");
    assert.equal(ORB.spec.team, "HUAQ24HBR6");
  });

  it("checks this Mac before anything is downloaded", async () => {
    const world = new World();
    const deps = { run: world.run, freeBytes: () => world.free, signal };
    assert.equal(await checkMac(deps, ORB, world.root, world.applicationsDir), "arm64");
    world.arm64 = false;
    assert.equal(await checkMac(deps, ORB, world.root, world.applicationsDir), "amd64");
    world.macos = "13.6";
    await assert.rejects(checkMac(deps, ORB, world.root, world.applicationsDir), /macOS 14 or newer/);
    world.macos = "14.0";
    world.gatekeeper = "assessments disabled";
    await assert.rejects(checkMac(deps, ORB, world.root, world.applicationsDir), /Gatekeeper is turned off/);
    world.gatekeeper = "assessments enabled";
    await assert.rejects(checkMac({ ...deps, freeBytes: (path) => (path === world.applicationsDir ? LIMITS.minFreeBytes - 1 : world.free) }, ORB, world.root, world.applicationsDir), /15 GB free/);
    chmodSync(world.applicationsDir, 0o500);
    await assert.rejects(checkMac(deps, ORB, world.root, world.applicationsDir), /can't write to/);
    chmodSync(world.applicationsDir, 0o700);
    world.installApp();
    await assert.rejects(checkMac(deps, ORB, world.root, world.applicationsDir), /already in/);
  });

  it("checks the disk image's own team and notarization", async () => {
    const world = new World();
    const dmg = join(world.root, "OrbStack.dmg");
    writeFileSync(dmg, "dmg");
    await verifyDmg(world.run, dmg, ORB, signal);
    const checks = world.ran("/usr/sbin/spctl", (args) => args.includes("open"));
    assert.deepEqual(checks[0]?.args, ["-a", "-vv", "-t", "open", "--context", "context:primary-signature", dmg]);
    world.dmgTeam = "ABCDE12345";
    await assert.rejects(verifyDmg(world.run, dmg, ORB, signal), /isn't signed by its vendor/);
    world.dmgTeam = ORB.spec.team;
    world.dmgNotarized = false;
    await assert.rejects(verifyDmg(world.run, dmg, ORB, signal), /isn't notarized/);
  });

  it("checks the app's requirement, notarization, bundle id and version floor", async () => {
    const world = new World();
    const app = join(mounted(world), "OrbStack.app");
    await verifyApp(world.run, app, ORB, { strict: true, gatekeeper: true, bundle: true }, signal);
    const strict = world.ran("/usr/bin/codesign")[0]?.args ?? [];
    assert.deepEqual(strict.slice(0, 3), ["--verify", "--deep", "--strict"]);
    assert.match(strict[3] ?? "", /identifier "dev\.kdrag0n\.MacVirt" and certificate leaf\[subject\.OU\] = "HUAQ24HBR6"/);
    await verifyApp(world.run, app, ORB, { strict: false, gatekeeper: false, bundle: false }, signal);
    assert.equal(world.ran("/usr/bin/codesign").at(-1)?.args.includes("--strict"), false);
    const failing: [string, () => void, RegExp][] = [
      ["wrong team", () => (world.appTeam = "ABCDE12345"), /isn't signed by OrbStack's vendor/],
      ["not notarized", () => (world.appNotarized = false), /isn't notarized/],
    ];
    for (const [, breakIt, message] of failing) {
      const saved = { team: world.appTeam, notarized: world.appNotarized };
      breakIt();
      await assert.rejects(verifyApp(world.run, app, ORB, { strict: true, gatekeeper: true, bundle: true }, signal), message);
      world.appTeam = saved.team;
      world.appNotarized = saved.notarized;
    }
  });

  it("refuses a wrong bundle id or a version below the floor", async () => {
    for (const [field, value, message] of [["appId", "com.example.other", /isn't OrbStack/], ["version", "2.2.4", /older than 2\.2\.5/]] as const) {
      const world = new World();
      if (field === "appId") {
        world.appId = value;
        world.signedId = ORB.spec.appId;
      } else world.version = value;
      const app = join(mounted(world), "OrbStack.app");
      await assert.rejects(verifyApp(world.run, app, ORB, { strict: true, gatekeeper: true, bundle: true }, signal), message);
    }
  });

  it("counts bundle bytes without following links and stops past the cap", () => {
    const world = new World();
    const dir = join(world.root, "big");
    mkdirSync(dir);
    writeFileSync(join(dir, "a"), Buffer.alloc(1000));
    symlinkSync("/usr", join(dir, "link"));
    assert.ok(bundleBytes(dir, 1_000_000) < 10_000);
    assert.ok(bundleBytes(dir, 10) > 10);
  });

  it("accepts the standard image root and refuses anything else", () => {
    const world = new World();
    assert.equal(inspectRoot(mounted(world), ORB), join(world.root, "mnt", "OrbStack.app"));
    const variants: [string, (mount: string) => void][] = [
      ["an extra entry", (mount) => writeFileSync(join(mount, "Install helper.command"), "#!/bin/sh")],
      ["a second app", (mount) => mkdirSync(join(mount, "Other.app"))],
      ["a hidden app", (mount) => mkdirSync(join(mount, ".Hidden.app"))],
      ["a dot-file link", (mount) => symlinkSync("/etc", join(mount, ".link"))],
    ];
    for (const [label, add] of variants) {
      const next = new World();
      const mount = mounted(next);
      add(mount);
      assert.throws(() => inspectRoot(mount, ORB), SetupError, label);
    }
    const linked = new World();
    linked.layout = (mount) => {
      mkdirSync(join(linked.root, "elsewhere", "OrbStack.app"), { recursive: true });
      symlinkSync(join(linked.root, "elsewhere", "OrbStack.app"), join(mount, "OrbStack.app"));
    };
    assert.throws(() => inspectRoot(mounted(linked), ORB), /doesn't expect/);
    const wrongLink = new World();
    wrongLink.layout = (mount) => {
      mkdirSync(join(mount, "OrbStack.app"));
      symlinkSync("/tmp", join(mount, "Applications"));
    };
    assert.throws(() => inspectRoot(mounted(wrongLink), ORB), /doesn't expect/);
    const empty = new World();
    empty.layout = () => undefined;
    assert.throws(() => inspectRoot(mounted(empty), ORB), /doesn't hold OrbStack\.app/);
  });

  it("requires exactly one volume, mounted at the private mount point", async () => {
    const world = new World();
    await attach(world.run, join(world.root, "x.dmg"), join(world.root, "m1"), signal);
    world.attachMounts = (mount) => [mount, "/Volumes/Other"];
    await assert.rejects(attach(world.run, join(world.root, "x.dmg"), join(world.root, "m2"), signal), /unexpected way/);
    world.attachMounts = () => ["/Volumes/OrbStack"];
    await assert.rejects(attach(world.run, join(world.root, "x.dmg"), join(world.root, "m3"), signal), /unexpected way/);
  });

  it("installs through a private staging folder and never overwrites", async () => {
    const world = new World();
    const app = join(mounted(world), "OrbStack.app");
    let committed = false;
    const target = await installApp({ run: world.run, tag: TAG, signal, committing: () => (committed = true) }, app, world.applicationsDir, ORB);
    assert.equal(target, join(world.applicationsDir, "OrbStack.app"));
    assert.ok(committed);
    assert.deepEqual(world.appsContent(), ["OrbStack.app"]);
    assert.equal(world.ran("/usr/bin/codesign").filter((call) => call.args.at(-1) === target).length, 1);
    const ditto = world.ran("/usr/bin/ditto")[0]?.args ?? [];
    assert.equal(ditto[0], "--noqtn");
    assert.match(ditto.at(-1) ?? "", /\/\.hive-setup-0b6f3c1e-[^/]+\/OrbStack\.app$/);

    const racing = new World();
    const source = join(mounted(racing), "OrbStack.app");
    const theirs = join(racing.applicationsDir, "OrbStack.app");
    racing.onDitto = () => {
      mkdirSync(theirs);
      writeFileSync(join(theirs, "owner.txt"), "the owner's");
    };
    await assert.rejects(installApp({ run: racing.run, tag: TAG, signal, committing: () => undefined }, source, racing.applicationsDir, ORB), /appeared in Applications/);
    assert.equal(readFileSync(join(theirs, "owner.txt"), "utf8"), "the owner's");
    assert.deepEqual(racing.appsContent(), ["OrbStack.app"]);
  });

  it("leaves nothing in Applications when the staged copy fails its check", async () => {
    const world = new World();
    const app = join(mounted(world), "OrbStack.app");
    world.onDitto = () => (world.appTeam = "ABCDE12345");
    await assert.rejects(installApp({ run: world.run, tag: TAG, signal, committing: () => undefined }, app, world.applicationsDir, ORB), /isn't signed/);
    assert.deepEqual(world.appsContent(), []);
  });

  it("cleans leftovers on daemon start: images from the setup folder, temp and staging folders", async () => {
    const world = new World();
    mkdirSync(join(world.cacheRoot, "run-0b6f3c1e-abc", "mnt"), { recursive: true });
    mkdirSync(join(world.cacheRoot, "keep-me"));
    mkdirSync(join(world.applicationsDir, ".hive-setup-0b6f3c1e-xyz"));
    mkdirSync(join(world.applicationsDir, "Other.app"));
    mkdirSync(join(world.cacheRoot, "run-99999999-other"));
    mkdirSync(join(world.applicationsDir, ".hive-setup-99999999-other"));
    world.info = { images: [
      { "image-path": join(world.cacheRoot, "run-0b6f3c1e-abc", "OrbStack.dmg"), "system-entities": [{ "dev-entry": "/dev/disk7" }, { "dev-entry": "/dev/disk7s1", "mount-point": join(world.cacheRoot, "run-0b6f3c1e-abc", "mnt") }] },
      { "image-path": join(world.cacheRoot, "run-99999999-other", "Docker.dmg"), "system-entities": [{ "dev-entry": "/dev/disk9s1", "mount-point": join(world.cacheRoot, "run-99999999-other", "mnt") }] },
      { "image-path": "/Users/me/Downloads/Other.dmg", "system-entities": [{ "dev-entry": "/dev/disk8s1", "mount-point": "/Volumes/Other" }] },
    ] };
    await cleanupLeftovers({ run: world.run, cacheRoot: world.cacheRoot, applicationsDir: world.applicationsDir, tag: TAG, log: (line) => world.logs.push(line) });
    assert.deepEqual(world.detached, [join(world.cacheRoot, "run-0b6f3c1e-abc", "mnt")]);
    assert.deepEqual(readdirSync(world.cacheRoot).sort(), ["keep-me", "run-99999999-other"]);
    assert.deepEqual(world.appsContent().sort(), [".hive-setup-99999999-other", "Other.app"].sort());
    assert.match(world.logs.join("\n"), /detached 1 image\(s\), removed 1 temp and 1 staging folder\(s\)/);
    assert.equal(existsSync(join(world.applicationsDir, ".hive-setup-0b6f3c1e-xyz")), false);
  });
});
