import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EngineSetup, type SetupEffects } from "../src/engineSetup.ts";
import { LIMITS } from "../src/engineSetupPins.ts";
import { setupStatusSchema } from "../src/engineSetupStatus.ts";
import { PROVIDERS } from "../src/engineSocket.ts";
import { engineOf, fakeTimers, ORB_CDN, ORB_URL, until, World } from "./engineSetupFixtures.ts";
import { removeTempDirs } from "./fixtures.ts";

function harness(world = new World(), overrides: Partial<SetupEffects> = {}) {
  const timers = fakeTimers();
  return { world, timers, setup: new EngineSetup(world.effects(timers, overrides)) };
}

async function outcome(setup: EngineSetup) {
  await setup.settled();
  return setup.status();
}

const ORB_APP = (world: World) => join(world.applicationsDir, "OrbStack.app");

describe("guided engine setup", () => {
  after(() => removeTempDirs());

  it("installs OrbStack end to end: verified, moved in, detached before launch, images prepared", async () => {
    const { world, setup } = harness();
    const first = await setup.start("orbstack");
    assert.equal(first.state, "running");
    assert.equal(first.action, "install");
    assert.equal(first.cancellable, true);
    const done = await outcome(setup);
    assert.equal(setupStatusSchema.safeParse(done).success, true);
    assert.equal(done.state, "done");
    assert.equal(done.step, "ready");
    assert.equal(done.progress, 1);
    assert.deepEqual(world.fetched, [{ url: ORB_URL, redirect: "manual" }, { url: ORB_CDN, redirect: "manual" }]);
    assert.deepEqual(world.appsContent(), ["OrbStack.app"]);
    assert.deepEqual(world.leftovers(), []);
    assert.deepEqual(world.opened, [ORB_APP(world)]);
    const quarantined = world.ran("/usr/bin/xattr")[0]?.args ?? [];
    assert.deepEqual(quarantined.slice(0, 2), ["-w", "com.apple.quarantine"]);
    assert.match(quarantined.at(-1) ?? "", /\/run-[^/]+\/OrbStack\.dmg$/);
    const detachAt = world.calls.findIndex((call) => call.args[0] === "detach");
    const openAt = world.calls.findIndex((call) => call.file === "/usr/bin/open");
    assert.ok(detachAt >= 0 && detachAt < openAt, "the image is detached before the app is launched");
    assert.equal(world.built.length, 1);
    assert.deepEqual(done.providers.map((entry) => [entry.id, entry.installed, entry.running, entry.active, entry.recommended]), [
      ["orbstack", true, true, true, true], ["docker-desktop", false, false, false, false],
    ]);
  });

  it("installs Docker Desktop for an Intel Mac from its own pinned URL", async () => {
    const world = new World();
    Object.assign(world, { arm64: false, appName: "Docker.app", appId: PROVIDERS["docker-desktop"].appId, version: "4.50.0", readyOnOpen: "docker-desktop" });
    world.dmgTeam = world.appTeam = PROVIDERS["docker-desktop"].team;
    const url = "https://desktop.docker.com/mac/main/amd64/Docker.dmg";
    world.responses = { [url]: () => new Response("dmg") };
    const { setup } = harness(world);
    await setup.start("docker-desktop");
    const done = await outcome(setup);
    assert.equal(done.state, "done", done.detail);
    assert.deepEqual(world.fetched.map((entry) => entry.url), [url]);
    assert.deepEqual(world.appsContent(), ["Docker.app"]);
  });

  it("starts an installed engine without downloading, after the installed-app check", async () => {
    const world = new World();
    world.installApp();
    const { setup } = harness(world);
    assert.equal((await setup.start("orbstack")).action, "start");
    const done = await outcome(setup);
    assert.equal(done.state, "done", done.detail);
    assert.deepEqual(world.fetched, []);
    const signed = world.ran("/usr/bin/codesign")[0]?.args ?? [];
    assert.equal(signed.includes("--strict"), false);
    assert.equal(signed.at(-1), ORB_APP(world));
    assert.deepEqual(world.ran("/usr/sbin/spctl")[0]?.args, ["-a", "-vv", "-t", "exec", ORB_APP(world)]);
    assert.deepEqual(world.opened, [ORB_APP(world)]);
  });

  it("refuses to start an installed app that fails its requirement", async () => {
    const world = new World();
    world.installApp();
    world.appTeam = "ABCDE12345";
    const { setup } = harness(world);
    await setup.start("orbstack");
    const done = await outcome(setup);
    assert.equal(done.state, "failed");
    assert.deepEqual(world.opened, []);
  });

  it("finishes without images when another engine's context stays selected, and never changes it", async () => {
    const world = new World();
    world.installApp();
    world.readyOnOpen = null;
    world.present = [engineOf("orbstack"), engineOf("docker-desktop")];
    world.active = { status: "ready", engine: engineOf("docker-desktop") };
    const { setup, timers } = harness(world);
    await setup.start("orbstack");
    await until(() => timers.live(LIMITS.pollMs), "the first poll");
    timers.fire(LIMITS.pollMs);
    const done = await outcome(setup);
    assert.equal(done.state, "done");
    assert.match(done.detail, /points at Docker Desktop.*doesn't change it/);
    assert.deepEqual(world.built, []);
    assert.equal(world.calls.some((call) => call.args.includes("context")), false);
  });

  it("fails after ten minutes when the engine never gets ready", async () => {
    const world = new World();
    world.installApp();
    world.readyOnOpen = null;
    const { setup, timers } = harness(world);
    await setup.start("orbstack");
    await until(() => timers.live(LIMITS.pollMs), "the first poll");
    assert.match((await setup.status()).detail, /yours to answer; Hive never answers them/);
    timers.fire(LIMITS.startWaitMs);
    const done = await outcome(setup);
    assert.equal(done.state, "failed");
    assert.match(done.detail, /within 10 minutes/);
  });

  const failures: [string, (world: World) => void, RegExp][] = [
    ["a DMG signed by another team", (world) => (world.dmgTeam = "ABCDE12345"), /disk image isn't signed by its vendor/],
    ["a DMG that isn't notarized", (world) => (world.dmgNotarized = false), /disk image isn't notarized/],
    ["an app signed by another team", (world) => (world.appTeam = "ABCDE12345"), /isn't signed by OrbStack's vendor/],
    ["an app that isn't notarized", (world) => (world.appNotarized = false), /OrbStack\.app isn't notarized/],
    ["a wrong bundle id", (world) => Object.assign(world, { appId: "com.example.fake", signedId: PROVIDERS.orbstack.appId }), /isn't OrbStack/],
    ["a version below the floor", (world) => (world.version = "2.1.0"), /older than 2\.2\.5/],
    ["an extra entry in the image", (world) => {
      const standard = world.layout;
      world.layout = (mount) => { standard(mount); writeFileSync(join(mount, "run-me.command"), "x"); };
    }, /holds something Hive doesn't expect/],
    ["a symlinked app in the image", (world) => (world.layout = (mount) => {
      mkdirSync(join(world.root, "outside", "OrbStack.app"), { recursive: true });
      symlinkSync(join(world.root, "outside", "OrbStack.app"), join(mount, "OrbStack.app"));
    }), /holds something Hive doesn't expect/],
    ["a redirect to an unlisted host", (world) => (world.responses[ORB_URL] = () => new Response(null, { status: 302, headers: { location: "https://mirror.example.net/OrbStack.dmg" } })), /isn't the vendor's own server/],
    ["a redirect to http", (world) => (world.responses[ORB_URL] = () => new Response(null, { status: 302, headers: { location: "http://cdn-updates.orbstack.dev/x.dmg" } })), /leave HTTPS/],
    ["low disk", (world) => (world.free = LIMITS.minFreeBytes - 1), /15 GB free/],
    ["an old macOS", (world) => (world.macos = "13.7.1"), /macOS 14/],
    ["an Applications folder Hive can't write", (world) => chmodSync(world.applicationsDir, 0o500), /can't write to/],
  ];

  for (const [label, breakIt, message] of failures) {
    it(`fails closed on ${label}, leaving nothing behind`, async () => {
      const world = new World();
      breakIt(world);
      const { setup } = harness(world);
      await setup.start("orbstack");
      const done = await outcome(setup);
      chmodSync(world.applicationsDir, 0o700);
      assert.equal(done.state, "failed");
      assert.match(done.detail, message);
      assert.deepEqual(world.appsContent(), []);
      assert.deepEqual(world.leftovers(), []);
      assert.deepEqual(world.opened, []);
      for (const call of world.ran("/usr/bin/hdiutil", (args) => args[0] === "attach")) {
        assert.ok(world.detached.includes(call.args[call.args.indexOf("-mountpoint") + 1] ?? ""), "an attached image is always detached");
      }
    });
  }

  it("never overwrites an app that appears just before the move", async () => {
    const world = new World();
    world.onDitto = () => {
      mkdirSync(ORB_APP(world));
      writeFileSync(join(ORB_APP(world), "owner.txt"), "mine");
    };
    const { setup } = harness(world);
    await setup.start("orbstack");
    const done = await outcome(setup);
    assert.equal(done.state, "failed");
    assert.equal(readFileSync(join(ORB_APP(world), "owner.txt"), "utf8"), "mine");
    assert.deepEqual(world.leftovers(), []);
  });

  it("answers a start and its progress at once while an engine check hangs, then checks again once it is done", async () => {
    const world = new World();
    world.installApp();
    let clock = 0;
    let hang: Promise<void> | null = null;
    let release: () => void = () => undefined;
    const base = world.effects(fakeTimers());
    const setup = new EngineSetup({ ...base, now: () => clock, engines: { ...base.engines, present: async () => {
      if (hang) await hang;
      return world.present;
    } } });
    assert.equal((await setup.status()).providers.find((entry) => entry.id === "orbstack")?.running, false);
    hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    clock = 10_000;
    const answered: { reply: Awaited<ReturnType<EngineSetup["start"]>> | null } = { reply: null };
    void setup.start("orbstack").then((value) => {
      answered.reply = value;
    });
    await until(() => answered.reply !== null, "the start reply");
    assert.equal(answered.reply?.state, "running");
    assert.equal(answered.reply?.action, "start");
    clock = 20_000;
    assert.equal((await setup.status()).state !== "idle", true);
    hang = null;
    release();
    await setup.settled();
    const done = await setup.status();
    assert.equal(done.state, "done");
    assert.equal(done.providers.find((entry) => entry.id === "orbstack")?.running, true);
  });
});
