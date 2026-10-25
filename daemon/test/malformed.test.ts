import assert from "node:assert/strict";
import type { Server } from "node:http";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { requestUrl } from "../src/requestTarget.ts";
import { startServer } from "../src/server.ts";
import { call, freePort } from "./fixtures.ts";

const UPGRADE = "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
const PROBE_TIMEOUT_MS = 3000;

function rawRequest(port: number, target: string, extraHeaders = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let reply = "";
    const timer = setTimeout(() => socket.destroy(), PROBE_TIMEOUT_MS);
    socket.on("data", (chunk: Buffer) => (reply += chunk.toString("latin1")));
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(reply.split("\r\n")[0] ?? "");
    });
    socket.on("error", reject);
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extraHeaders}\r\n`);
  });
}

function status(line: string): number {
  return Number(line.split(" ")[1] ?? 0);
}

describe("request targets", () => {
  it("accepts origin-form paths and rejects everything else", () => {
    assert.equal(requestUrl("/api/state?x=1", 47321)?.pathname, "/api/state");
    for (const target of [undefined, "", "*", "//", "//evil.test/x", "/\\", "/a\\b", "/a\u0001b", "/a\u007fb", "http://127.0.0.1:47321/", "http://[", "http://"]) {
      assert.equal(requestUrl(target, 47321), null, String(target));
    }
  });
});

describe("malformed requests", () => {
  const store = new Store(":memory:");
  const hub = new Hub(store, { command: "node", args: [], url: "http://127.0.0.1:1" });
  let server: Server;
  let port = 0;

  before(async () => {
    port = await freePort();
    server = startServer({ hub, uiSecret: "u".repeat(64), port, webDir: "/nonexistent" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    hub.shutdown();
  });

  const probes: [string, string, string][] = [
    ["a backslash path", "/\\", ""],
    ["an unterminated IPv6 absolute form", "http://[", ""],
    ["an empty-host absolute form", "http://", ""],
    ["an absolute-form request", "http://127.0.0.1:PORT/screen/../token", ""],
    ["a raw control character", "/a\u0001b", ""],
    ["a WebSocket upgrade to //", "//", UPGRADE],
    ["a WebSocket upgrade to a backslash", "/\\", UPGRADE],
    ["a WebSocket upgrade to /%", "/%", UPGRADE],
  ];

  for (const [name, target, headers] of probes) {
    it(`answers ${name} with a 4xx or a closed socket and keeps serving`, async () => {
      const line = await rawRequest(port, target.replace("PORT", String(port)), headers);
      assert.ok(line === "" || (status(line) >= 400 && status(line) < 500), `${name}: ${line}`);
      assert.equal((await call(port, "GET", "/health")).status, 200);
    });
  }

  it("refuses absolute-form requests with 400 instead of serving the board", async () => {
    assert.equal(status(await rawRequest(port, `http://127.0.0.1:${port}/screen/../token`)), 400);
    assert.equal(status(await rawRequest(port, "/\\")), 400);
  });
});
