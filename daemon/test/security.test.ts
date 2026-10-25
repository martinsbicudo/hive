import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { withoutSecrets } from "../src/process.ts";
import { RunTokens } from "../src/runTokens.ts";
import { readUiSecret } from "../src/secret.ts";

describe("run tokens", () => {
  it("issues a random token per run, resolves it to its agent and forgets it once revoked", () => {
    const tokens = new RunTokens();
    const first = tokens.issue("agent-a");
    const second = tokens.issue("agent-a");
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.notEqual(first, second);
    assert.equal(tokens.resolve(first), "agent-a");
    tokens.revoke(first);
    assert.equal(tokens.resolve(first), null);
    assert.equal(tokens.resolve(second), "agent-a");
    assert.equal(tokens.resolve(null), null);
    assert.equal(tokens.resolve(""), null);
    assert.equal(tokens.resolve("not-a-token"), null);
  });
});

describe("engine environment", () => {
  it("drops Hive secrets and GitHub tokens and keeps everything else", () => {
    const env = withoutSecrets({
      HIVE_TOKEN: "t", HIVE_SECRET_STDIN: "1", HIVE_SECRET: "s", GH_TOKEN: "g", GITHUB_TOKEN: "g",
      GH_ENTERPRISE_TOKEN: "g", CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", HIVE_PORT: "47321", LANG: "en_US.UTF-8",
    });
    assert.deepEqual(env, { HIVE_PORT: "47321", LANG: "en_US.UTF-8" });
  });
});

describe("UI secret on stdin", () => {
  it("reads the first line and trims it", async () => {
    const stream = new PassThrough();
    const reading = readUiSecret(stream, 1000);
    stream.write(`  ${"a".repeat(64)}  \nignored`);
    assert.equal(await reading, "a".repeat(64));
  });

  it("rejects a short secret, a closed stream and silence", async () => {
    const short = new PassThrough();
    const shortReading = readUiSecret(short, 1000);
    short.end("tooshort\n");
    await assert.rejects(shortReading, /at least 32/);
    const closed = new PassThrough();
    const closedReading = readUiSecret(closed, 1000);
    closed.end();
    await assert.rejects(closedReading, /at least 32/);
    await assert.rejects(readUiSecret(new PassThrough(), 10), /timed out/);
  });
});
