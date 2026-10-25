import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { spawnEngine } from "../src/runProcess.ts";
import { removeTempDirs, tempDir } from "./fixtures.ts";

after(removeTempDirs);

describe("engine processes", () => {
  it("reports an engine that exits before reading its prompt, instead of crashing the daemon", async () => {
    const errors: string[] = [];
    const closed = new Promise<number | null>((resolve) => {
      spawnEngine("/bin/sh", ["-c", "exit 3"], tempDir("hive-engine-"), "x".repeat(4 * 1024 * 1024), "claude-code", {
        event: () => undefined,
        error: (message) => errors.push(message),
        close: (code) => resolve(code),
      });
    });
    assert.equal(await closed, 3);
    assert.deepEqual(errors, []);
  });
});
