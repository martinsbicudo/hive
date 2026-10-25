import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileRunner } from "../src/commandRunner.ts";
import { dockerRunner } from "../src/docker.ts";

const LINGER = ["-e", "setTimeout(() => {}, 30000)"];

describe("runner cancel", () => {
  it("kills a command's child when its signal aborts", async () => {
    const controller = new AbortController();
    const pending = execFileRunner(process.execPath, LINGER, { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();
    const result = await pending;
    assert.notEqual(result.code, 0);
    assert.equal(result.timedOut, false);
  });

  it("kills a docker child (an image build) when its signal aborts, even if aborted before the call", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await dockerRunner(process.execPath)(LINGER, { signal: controller.signal, timeoutMs: 60_000 });
    assert.notEqual(result.code, 0);
  });
});
