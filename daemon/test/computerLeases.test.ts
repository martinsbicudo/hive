import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComputerLeases } from "../src/computerLeases.ts";

describe("computer turn leases", () => {
  it("serializes a resource and grants the next queued run after release", async () => {
    const leases = new ComputerLeases();
    const first = await leases.acquire("ana", "computer-1", 1);
    let secondReady = false;
    const secondPromise = leases.acquire("bob", "computer-1", 1).then((lease) => {
      secondReady = true;
      return lease;
    });
    await Promise.resolve();
    assert.equal(secondReady, false);
    leases.release(first.id);
    const second = await secondPromise;
    assert.equal(second.agentId, "bob");
    assert.equal(leases.isCurrent("bob", "computer-1", 1, second.id), true);
    leases.release(second.id);
  });

  it("rejects a detached agent's waiter and invalidates its active lease", async () => {
    const leases = new ComputerLeases();
    const first = await leases.acquire("ana", "computer-1", 1);
    const waiting = leases.acquire("bob", "computer-1", 1);
    leases.invalidateAgent("ana");
    leases.invalidateAgent("bob");
    assert.equal(leases.isCurrent("ana", "computer-1", 1, first.id), false);
    await assert.rejects(waiting, /assignment changed/);
    leases.release(first.id);
    const next = await leases.acquire("cora", "computer-1", 2);
    assert.equal(next.revision, 2);
    leases.release(next.id);
  });

  it("rejects stale queued revisions when resource membership changes", async () => {
    const leases = new ComputerLeases();
    const active = await leases.acquire("ana", "computer-1", 2);
    const stale = leases.acquire("bob", "computer-1", 2);
    leases.invalidateComputer("computer-1");
    assert.equal(leases.isCurrent("ana", "computer-1", 2, active.id), false);
    await assert.rejects(stale, /configuration changed/);
    leases.release(active.id);
  });

  it("resolves release waiters before mutation releases a queued run", async () => {
    const leases = new ComputerLeases();
    const active = await leases.acquire("ana", "computer-1", 1);
    assert.equal(leases.reserveMutation("computer-1"), true);
    let released = false;
    const releasedPromise = leases.waitForRelease("computer-1").then(() => { released = true; });
    let queued = false;
    const queuedPromise = leases.acquire("bob", "computer-1", 1).then((lease) => {
      queued = true;
      return lease;
    });

    leases.release(active.id);
    await releasedPromise;
    assert.equal(released, true);
    await Promise.resolve();
    assert.equal(queued, false);

    leases.finishMutation("computer-1", 1);
    const next = await queuedPromise;
    assert.equal(next.agentId, "bob");
    assert.equal(leases.isCurrent("bob", "computer-1", 1, next.id), true);
    leases.release(next.id);
  });
});
