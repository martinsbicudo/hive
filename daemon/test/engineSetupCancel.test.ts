import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EngineSetup, type SetupEffects } from "../src/engineSetup.ts";
import { LIMITS, SetupRefused } from "../src/engineSetupPins.ts";
import { fakeTimers, ORB_CDN, silentBody, until, World, type Call } from "./engineSetupFixtures.ts";
import { removeTempDirs } from "./fixtures.ts";

function harness(world = new World(), overrides: Partial<SetupEffects> = {}) {
  return { world, setup: new EngineSetup(world.effects(fakeTimers(), overrides)) };
}

const inMount = (call: Call) => call.file === "/usr/bin/codesign" && /\/mnt\/OrbStack\.app$/.test(call.args.at(-1) ?? "");

describe("guided engine setup: refusals and cancel", () => {
  after(() => removeTempDirs());

  it("refuses a second setup while one runs", async () => {
    const world = new World();
    world.block = (call) => call.file === "/usr/bin/sw_vers";
    const { setup } = harness(world);
    await setup.start("orbstack");
    await assert.rejects(setup.start("docker-desktop"), SetupRefused);
    await setup.cancel();
  });

  it("refuses while a computer is active and while Hive is paused", async () => {
    await assert.rejects(harness(new World(), { anyActive: () => true }).setup.start("orbstack"), /Stop your computers/);
    await assert.rejects(harness(new World(), { paused: () => true }).setup.start("orbstack"), /Hive is paused/);
  });

  const steps: [string, (world: World) => void, (world: World) => boolean][] = [
    ["checking this Mac", (world) => (world.block = (call) => call.file === "/usr/bin/sw_vers"), (world) => world.blocked.length > 0],
    ["downloading", (world) => (world.responses[ORB_CDN] = () => new Response(silentBody())), (world) => world.fetched.length === 2],
    ["verifying the image", (world) => (world.block = (call) => call.file === "/usr/bin/codesign" && (call.args.at(-1) ?? "").endsWith(".dmg")), (world) => world.blocked.length > 0],
    ["verifying the app inside the mounted image", (world) => (world.block = inMount), (world) => world.blocked.length > 0],
    ["copying into staging", (world) => (world.block = (call) => call.file === "/usr/bin/ditto"), (world) => world.blocked.length > 0],
  ];

  for (const [label, arrange, reached] of steps) {
    it(`cancels while ${label}: temp removed, image detached, nothing in Applications`, async () => {
      const world = new World();
      arrange(world);
      const { setup } = harness(world);
      await setup.start("orbstack");
      await until(() => reached(world), label);
      const cancelled = await setup.cancel();
      assert.equal(cancelled.state, "cancelled");
      assert.match(cancelled.detail, /Nothing was installed/);
      assert.deepEqual(world.appsContent(), []);
      assert.deepEqual(world.leftovers(), []);
      assert.deepEqual(world.opened, []);
    });
  }

  it("cancels during the start wait and keeps the installed app", async () => {
    const world = new World();
    world.readyOnOpen = null;
    const timers = fakeTimers();
    const setup = new EngineSetup(world.effects(timers));
    await setup.start("orbstack");
    await until(() => timers.live(LIMITS.pollMs), "the start wait");
    assert.equal((await setup.status()).cancellable, true);
    const cancelled = await setup.cancel();
    assert.equal(cancelled.state, "cancelled");
    assert.match(cancelled.detail, /OrbStack\.app stays installed/);
    assert.deepEqual(world.appsContent(), ["OrbStack.app"]);
    assert.deepEqual(world.leftovers(), []);
    assert.equal(timers.live(LIMITS.pollMs) || timers.live(LIMITS.startWaitMs), false);
  });

  it("cancels while images build and kills the build through its signal", async () => {
    const world = new World();
    world.imagesGate = new Promise(() => undefined);
    const { setup } = harness(world);
    await setup.start("orbstack");
    await until(() => world.built.length > 0, "the image build");
    assert.equal((await setup.status()).step, "images");
    const cancelled = await setup.cancel();
    assert.equal(cancelled.state, "cancelled");
    assert.equal(world.imageSignal?.aborted, true);
  });

  it("can't be cancelled during the move, and a pause then cancels before launch", async () => {
    const world = new World();
    const target = join(world.applicationsDir, "OrbStack.app");
    world.block = (call) => call.file === "/usr/bin/codesign" && call.args.at(-1) === target;
    const { setup } = harness(world);
    await setup.start("orbstack");
    await until(() => world.blocked.length > 0, "the final check");
    assert.equal((await setup.status()).cancellable, false);
    await assert.rejects(setup.cancel(), /can't be cancelled/);
    setup.cancelForPause();
    world.releaseAll();
    await setup.settled();
    const done = await setup.status();
    assert.equal(done.state, "cancelled");
    assert.match(done.detail, /stays installed/);
    assert.deepEqual(world.opened, []);
    assert.deepEqual(world.leftovers(), []);
  });

  it("cancelling with nothing running is a no-op", async () => {
    const { setup } = harness();
    assert.equal((await setup.cancel()).state, "idle");
  });
});
