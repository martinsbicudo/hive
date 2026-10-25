import assert from "node:assert/strict";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { openerMessage, screenParams, screenParamsFrom, socketUrl } from "../screen/params.js";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { SCREEN_CSP, screenFile } from "../src/screenPage.ts";
import { startServer } from "../src/server.ts";
import { freePort } from "./fixtures.ts";

const TOKEN = "ab".repeat(32);
const PASSWORD = "0f1e2d3c";

interface Page {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function get(port: number, path: string, method = "GET"): Promise<Page> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}` } }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("screen link parameters", () => {
  it("accepts a well-formed fragment and builds the websockify URL", () => {
    const params = screenParams(`#port=49153&token=${TOKEN}&password=${PASSWORD}&agent=x`);
    assert.deepEqual(params, { port: 49153, token: TOKEN, password: PASSWORD });
    assert.ok(params);
    assert.equal(socketUrl(params), `ws://127.0.0.1:49153/websockify?token=${TOKEN}`);
  });

  it("refuses tokens that aren't 64 lowercase hex characters", () => {
    for (const token of ["", "zz".repeat(32), TOKEN.toUpperCase(), TOKEN.slice(2), `${TOKEN}00`, `${TOKEN.slice(2)}%20`, `${TOKEN.slice(2)}&x`]) {
      assert.equal(screenParams(`#port=49153&token=${token}&password=${PASSWORD}`), null, token);
    }
  });

  it("refuses ports outside 1024-65535 or not plain digits", () => {
    for (const port of ["80", "1023", "65536", "99999", "0x1f90", "4915a", "", "+4915", "4915.3"]) {
      assert.equal(screenParams(`#port=${port}&token=${TOKEN}&password=${PASSWORD}`), null, port);
    }
    assert.ok(screenParams(`#port=1024&token=${TOKEN}&password=${PASSWORD}`));
    assert.ok(screenParams(`#port=65535&token=${TOKEN}&password=${PASSWORD}`));
  });

  it("refuses a bad or missing password and duplicated keys", () => {
    assert.equal(screenParams(`#port=49153&token=${TOKEN}`), null);
    assert.equal(screenParams(`#port=49153&token=${TOKEN}&password=short`), null);
    assert.equal(screenParams(`#port=49153&token=${TOKEN}&password=${PASSWORD}&token=${"cd".repeat(32)}`), null);
  });
});

describe("screen secrets from the board window", () => {
  const opener = { name: "board" };
  const origin = "http://127.0.0.1:47321";
  const data = { port: 49153, token: TOKEN, password: PASSWORD };

  it("accepts well-formed secrets with an integer port", () => {
    assert.deepEqual(screenParamsFrom(data), data);
    for (const bad of [null, [], "x", { ...data, port: "49153" }, { ...data, port: 49153.5 }, { ...data, port: 80 }, { ...data, token: TOKEN.toUpperCase() }, { ...data, password: 12345678 }, { port: 49153, token: TOKEN }]) {
      assert.equal(screenParamsFrom(bad), null, JSON.stringify(bad));
    }
  });

  it("takes secrets only from the opener on the same origin", () => {
    assert.deepEqual(openerMessage({ origin, source: opener, data }, origin, opener), { kind: "secrets", params: data });
    assert.deepEqual(openerMessage({ origin, source: opener, data: { ...data, token: "nope" } }, origin, opener), { kind: "invalid" });
    assert.deepEqual(openerMessage({ origin: "http://127.0.0.1:47322", source: opener, data }, origin, opener), { kind: "ignore" });
    assert.deepEqual(openerMessage({ origin, source: { name: "other" }, data }, origin, opener), { kind: "ignore" });
    assert.deepEqual(openerMessage({ origin, source: null, data }, origin, null), { kind: "ignore" });
  });
});

describe("screen page files", () => {
  it("maps only the page files and noVNC's core and vendor scripts", () => {
    assert.ok(screenFile("/screen/")?.endsWith("index.html"));
    assert.ok(screenFile("/screen/novnc/core/rfb.js")?.endsWith("rfb.js"));
    assert.ok(screenFile("/screen/novnc/vendor/pako/lib/zlib/inflate.js"));
    for (const path of ["/screen/params.d.ts", "/screen/novnc/package.json", "/screen/novnc/docs/API.md", "/screen/novnc/core/../../package.json",
      "/screen/novnc/core/%2e%2e/%2e%2e/%2e%2e/src/server.ts", "/screen/novnc/core/..%2f..%2f..%2fpackage.json", "/screen/%E0%A4%A", "/screen/novnc/core\\rfb.js", "/screen/../src/server.ts", "/screen/novnc/core/%2e%2e/%2e%2e/ws/index.js", "/screen/novnc/vendor/../../../screen/screen.js"]) {
      assert.equal(screenFile(path), null, path);
    }
  });
});

describe("screen page server", () => {
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

  it("serves a static page under a strict CSP with no inline script and no secret", async () => {
    const page = await get(port, "/screen/");
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-security-policy"], SCREEN_CSP);
    assert.match(SCREEN_CSP, /frame-ancestors 'none'/);
    assert.match(SCREEN_CSP, /connect-src ws:\/\/127\.0\.0\.1:\*/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["cross-origin-opener-policy"], undefined, "COOP would cut the board's opener handshake");
    assert.doesNotMatch(page.body, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(page.body, /\bon[a-z]+=/i);
    assert.doesNotMatch(page.body, /[0-9a-f]{32}/);
    assert.doesNotMatch(page.body, /u{64}/);
  });

  it("serves noVNC as JavaScript and 404s anything else under /screen/", async () => {
    const rfb = await get(port, "/screen/novnc/core/rfb.js");
    assert.equal(rfb.status, 200);
    assert.match(String(rfb.headers["content-type"]), /^text\/javascript/);
    assert.equal((await get(port, "/screen/novnc/package.json")).status, 404);
    assert.equal((await get(port, "/screen/missing.js")).status, 404);
    assert.equal((await get(port, "/screen/", "POST")).status, 404);
    assert.equal((await get(port, "/screen")).status, 308);
  });

  it("judges the raw request path, so paths that normalize elsewhere never reach the board", async () => {
    for (const path of ["/screen/%2e%2e/x", "/screen/../token", "/screen/../api/state", "/screen/./index.html", "/screens", "/api/../screen/x"]) {
      const page = await get(port, path);
      assert.equal(page.status, 404, path);
      assert.equal(page.headers["content-security-policy"], SCREEN_CSP, path);
    }
    for (const path of ["//screen/index.html", "//"]) assert.equal((await get(port, path)).status, 400, path);
  });
});
