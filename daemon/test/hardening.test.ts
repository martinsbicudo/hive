import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ComputerService } from "../src/computerService.ts";
import { Store } from "../src/db.ts";
import { healthProof } from "../src/health.ts";
import { Hub } from "../src/hub.ts";
import { oneLine } from "../src/log.ts";
import { ensureDirs, logPath } from "../src/paths.ts";
import { requestUrl } from "../src/requestTarget.ts";
import { startServer } from "../src/server.ts";
import { notifications } from "./controlFixtures.ts";
import { call, field, freePort, removeTempDirs, tempDir } from "./fixtures.ts";
import { addAgent, until } from "./taskFixtures.ts";

const SHARED_SECRET = "hive-shared-test-secret-0123456789abcdef";
const SHARED_NONCE = "00112233445566778899aabbccddeeff";
const SHARED_PROOF = "350438b5bd9942c2c2b828767702058730140fd144381c0a4e207387b8dfb2fb";
const PROBE_TIMEOUT_MS = 3000;
const UPGRADE = "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";

after(removeTempDirs);

function rawStatus(port: number, target: string, headers: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let reply = "";
    const timer = setTimeout(() => socket.destroy(), PROBE_TIMEOUT_MS);
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("latin1");
      if (reply.includes("\r\n")) socket.destroy();
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(Number((reply.split("\r\n")[0] ?? "").split(" ")[1] ?? 0));
    });
    socket.on("error", reject);
    socket.write(`GET ${target} HTTP/1.1\r\n${headers}\r\n`);
  });
}

function headerOf(port: number, path: string, name: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path }, (response) => {
      response.resume();
      const value = response.headers[name];
      resolve(typeof value === "string" ? value : undefined);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("health proof", () => {
  it("matches the vector shared with the app's tests", () => {
    assert.equal(healthProof(SHARED_SECRET, SHARED_NONCE), SHARED_PROOF);
  });

  describe("over HTTP", () => {
    const store = new Store(":memory:");
    const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" });
    const webDir = tempDir("hive-web-");
    let server: Server;
    let port = 0;

    before(async () => {
      writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Hive</title>");
      port = await freePort();
      server = startServer({ hub, uiSecret: SHARED_SECRET, port, webDir });
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    });

    after(() => {
      server.closeAllConnections();
      server.close();
      hub.shutdown();
    });

    it("answers a valid nonce with the proof and no nonce with the plain reply", async () => {
      const proven = await call(port, "GET", `/health?nonce=${SHARED_NONCE}`);
      assert.equal(proven.status, 200);
      assert.equal(field(proven.body, "proof"), SHARED_PROOF);
      assert.equal(field(proven.body, "ok"), true);
      const plain = await call(port, "GET", "/health");
      assert.equal(plain.status, 200);
      assert.equal(field(plain.body, "proof"), undefined);
      assert.equal(typeof field(plain.body, "version"), "string");
    });

    it("refuses any nonce that isn't exactly 32 lowercase hex characters", async () => {
      const bad = [
        "", SHARED_NONCE.toUpperCase(), SHARED_NONCE.slice(1), `${SHARED_NONCE}0`, `${SHARED_NONCE.slice(2)}zz`,
        `${SHARED_NONCE}&nonce=${SHARED_NONCE}`,
      ];
      for (const nonce of bad) {
        const reply = await call(port, "GET", `/health?nonce=${nonce}`);
        assert.equal(reply.status, 400, nonce);
        assert.equal(field(reply.body, "proof"), undefined, nonce);
      }
    });

    it("answers /% and a decoded NUL with 400 and keeps serving", async () => {
      const host = `Host: 127.0.0.1:${port}\r\n`;
      assert.equal(await rawStatus(port, "/%", host), 400);
      assert.equal(await rawStatus(port, "/%00", host), 400);
      assert.equal(await rawStatus(port, "/api/%00/state", host), 400);
      assert.equal(await rawStatus(port, "/%", host + UPGRADE), 400);
      assert.equal((await call(port, "GET", "/health")).status, 200);
      assert.equal(requestUrl("/%", port), null);
      assert.equal(requestUrl("/a%00b", port), null);
      assert.equal(requestUrl("/a%20b", port)?.pathname, "/a%20b");
    });

    it("refuses a duplicate Host header on requests and upgrades", async () => {
      const good = `Host: 127.0.0.1:${port}\r\n`;
      assert.equal(await rawStatus(port, "/health", good), 200);
      assert.equal(await rawStatus(port, "/health", good + good), 403);
      assert.equal(await rawStatus(port, "/health", good + "Host: evil.example\r\n"), 403);
      const upgrade = `/ws?token=${SHARED_SECRET}`;
      assert.equal(await rawStatus(port, upgrade, good + UPGRADE), 101);
      assert.equal(await rawStatus(port, upgrade, good + good + UPGRADE), 403);
      assert.equal(await rawStatus(port, upgrade, good + "Host: evil.example\r\n" + UPGRADE), 403);
    });

    it("serves the board with a script-src 'self' policy", async () => {
      assert.equal(await headerOf(port, "/", "content-security-policy"), "script-src 'self'");
      assert.equal(await headerOf(port, "/agents/x", "content-security-policy"), "script-src 'self'");
    });
  });
});

describe("run failure log line", () => {
  it("escapes CR, LF and control characters and caps the length", () => {
    assert.equal(oneLine("a\nb\rc\u001bd\u0000e f"), "a\\nb\\rc\\u001bd\\u0000e\\u2028f");
    const capped = oneLine("x".repeat(2000));
    assert.equal(capped.length, 500);
    assert.ok(capped.endsWith("…"));
    assert.equal(oneLine("\n".repeat(400)).length, 500);
  });

  it("writes one capped, escaped line for a failed run", async () => {
    ensureDirs();
    const engine = join(tempDir("hive-noisy-engine-"), "claude");
    writeFileSync(engine, `#!/bin/sh\nprintf 'MARK-ONE\\n\\033[31mforged 2026-01-01T00:00:00Z run ok\\r\\n%s\\n' "$(printf 'y%.0s' $(seq 1 900))" >&2\nexit 3\n`);
    chmodSync(engine, 0o755);
    const store = new Store(":memory:");
    const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" }, new ComputerService(), { findEngine: () => engine });
    try {
      const ana = addAgent(store, { name: "Ana" });
      const notes = notifications(hub);
      hub.send(ana.id, "go");
      await until(() => notes.some((note) => note.kind === "failed"), "the failed run");
      assert.ok(existsSync(logPath));
      const lines = readFileSync(logPath, "utf8").split("\n").filter((line) => line.includes("MARK-ONE"));
      assert.equal(lines.length, 1);
      const line = lines[0] ?? "";
      assert.ok(!readFileSync(logPath, "utf8").split("\n").some((other) => other.startsWith("forged") || other.startsWith("\u001b")));
      const message = line.slice(line.indexOf(" ") + 1);
      assert.equal(message.length, 500);
      assert.match(message, /^run \S+ failed \(\$0\.0000\): MARK-ONE\\n\\u001b\[31mforged .*\\r\\ny+…$/);
    } finally {
      hub.shutdown();
    }
  });
});
