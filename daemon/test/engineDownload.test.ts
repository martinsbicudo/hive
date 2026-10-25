import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkedUrl, download, type SetupFetch } from "../src/engineDownload.ts";
import { LIMITS, SetupCancelled, SetupError } from "../src/engineSetupPins.ts";
import { fakeTimers, silentBody, until } from "./engineSetupFixtures.ts";
import { removeTempDirs, tempDir } from "./fixtures.ts";

const HOSTS = ["orbstack.dev", "cdn-updates.orbstack.dev"];
const START = "https://orbstack.dev/download/stable/latest/arm64";
const FILE = "https://cdn-updates.orbstack.dev/arm64/OrbStack.dmg";
const BYTES = Buffer.from("dmg".repeat(100));

function redirect(location: string): Response {
  return new Response(null, { status: 307, headers: { location } });
}

function server(routes: Record<string, () => Response>) {
  const seen: { url: string; redirect: string }[] = [];
  const fetcher: SetupFetch = async (url, init) => {
    seen.push({ url, redirect: init.redirect });
    const respond = routes[url];
    return respond ? respond() : new Response("missing", { status: 404 });
  };
  return { seen, fetcher };
}

function request(dest: string, signal = new AbortController().signal) {
  const progress: [number, number | null][] = [];
  return { progress, request: { url: START, hosts: HOSTS, dest, signal, onBytes: (received: number, total: number | null) => progress.push([received, total]) } };
}

describe("engine download", () => {
  after(() => removeTempDirs());
  const dest = () => join(tempDir("hive-dl-"), "OrbStack.dmg");

  it("accepts only https on the default port, without userinfo, on the exact hosts", () => {
    assert.equal(checkedUrl("/x/y.dmg", HOSTS, START).href, "https://orbstack.dev/x/y.dmg");
    assert.equal(checkedUrl("https://orbstack.dev:443/a", HOSTS).hostname, "orbstack.dev");
    assert.throws(() => checkedUrl("http://orbstack.dev/a", HOSTS), SetupError);
    assert.throws(() => checkedUrl("https://orbstack.dev:8443/a", HOSTS), SetupError);
    assert.throws(() => checkedUrl("https://user:pw@orbstack.dev/a", HOSTS), SetupError);
    assert.throws(() => checkedUrl("https://evil.orbstack.dev/a", HOSTS), SetupError);
    assert.throws(() => checkedUrl("https://orbstack.dev.evil.com/a", HOSTS), SetupError);
  });

  it("follows a checked redirect itself and writes a private file with progress", async () => {
    const { seen, fetcher } = server({ [START]: () => redirect(FILE), [FILE]: () => new Response(BYTES, { headers: { "content-length": String(BYTES.length) } }) });
    const path = dest();
    const { progress, request: input } = request(path);
    await download(fetcher, fakeTimers().timer, input);
    assert.deepEqual(seen.map((entry) => entry.url), [START, FILE]);
    assert.ok(seen.every((entry) => entry.redirect === "manual"));
    assert.deepEqual(readFileSync(path), BYTES);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(progress.at(-1), [BYTES.length, BYTES.length]);
  });

  for (const [label, location] of [
    ["an unlisted host", "https://downloads.example.com/OrbStack.dmg"],
    ["plain http", "http://cdn-updates.orbstack.dev/OrbStack.dmg"],
    ["userinfo", "https://me@cdn-updates.orbstack.dev/OrbStack.dmg"],
  ] as const) {
    it(`refuses a redirect to ${label} and never fetches it`, async () => {
      const { seen, fetcher } = server({ [START]: () => redirect(location) });
      const path = dest();
      await assert.rejects(download(fetcher, fakeTimers().timer, request(path).request), SetupError);
      assert.equal(seen.length, 1);
      assert.equal(existsSync(path), false);
    });
  }

  it("allows three redirects and refuses a fourth", async () => {
    const hop = (n: number) => `https://orbstack.dev/hop/${n}`;
    const three = server({ [START]: () => redirect(hop(1)), [hop(1)]: () => redirect(hop(2)), [hop(2)]: () => redirect(FILE), [FILE]: () => new Response(BYTES) });
    await download(three.fetcher, fakeTimers().timer, request(dest()).request);
    const four = server({ [START]: () => redirect(hop(1)), [hop(1)]: () => redirect(hop(2)), [hop(2)]: () => redirect(hop(3)), [hop(3)]: () => redirect(FILE), [FILE]: () => new Response(BYTES) });
    await assert.rejects(download(four.fetcher, fakeTimers().timer, request(dest()).request), /redirected too many times/);
    assert.equal(four.seen.some((entry) => entry.url === FILE), false);
  });

  it("refuses an oversize download by its header before reading the body", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ pull: (controller) => { pulled = true; controller.enqueue(new Uint8Array(1)); } }, { highWaterMark: 0 });
    const { fetcher } = server({ [START]: () => new Response(body, { headers: { "content-length": String(LIMITS.maxDownloadBytes + 1) } }) });
    const path = dest();
    await assert.rejects(download(fetcher, fakeTimers().timer, request(path).request), /larger than Hive allows/);
    assert.equal(existsSync(path), false);
    assert.equal(pulled, false);
  });

  it("refuses an oversize download by counting the stream when the header is absent", async () => {
    const { fetcher } = server({ [START]: () => new Response(BYTES) });
    await assert.rejects(download(fetcher, fakeTimers().timer, { ...request(dest()).request, maxBytes: BYTES.length - 1 }), /larger than Hive allows/);
  });

  it("never writes over an existing file", async () => {
    const path = dest();
    writeFileSync(path, "mine");
    const { fetcher } = server({ [START]: () => new Response(BYTES) });
    await assert.rejects(download(fetcher, fakeTimers().timer, request(path).request), /EEXIST/);
    assert.equal(readFileSync(path, "utf8"), "mine");
  });

  it("refuses a non-200 answer", async () => {
    const { fetcher } = server({});
    await assert.rejects(download(fetcher, fakeTimers().timer, request(dest()).request), /answered 404/);
  });

  for (const [label, ms, message] of [["a minute without data", LIMITS.idleMs, /stalled/], ["45 minutes in total", LIMITS.totalMs, /longer than 45 minutes/]] as const) {
    it(`stops after ${label}`, async () => {
      const timers = fakeTimers();
      const { fetcher } = server({ [START]: () => new Response(silentBody()) });
      const path = dest();
      const pending = download(fetcher, timers.timer, request(path).request);
      await until(() => existsSync(path), "the body to be read");
      timers.fire(ms);
      await assert.rejects(pending, message);
      assert.equal(timers.live(LIMITS.idleMs) || timers.live(LIMITS.totalMs), false);
    });
  }

  it("re-arms the idle timer on every chunk", async () => {
    const timers = fakeTimers();
    const stream: { push: ((chunk: Uint8Array | null) => void) | null } = { push: null };
    const body = new ReadableStream<Uint8Array>({ start: (controller) => { stream.push = (chunk) => (chunk ? controller.enqueue(chunk) : controller.close()); } });
    const { fetcher } = server({ [START]: () => new Response(body) });
    const path = dest();
    const pending = download(fetcher, timers.timer, request(path).request);
    await until(() => stream.push !== null && timers.live(LIMITS.idleMs), "stream");
    stream.push?.(new Uint8Array([1, 2]));
    await until(() => existsSync(path) && statSync(path).size === 2, "first chunk");
    stream.push?.(null);
    await pending;
  });

  it("cancels on the caller's signal, even while the stream is silent", async () => {
    const controller = new AbortController();
    const { fetcher } = server({ [START]: () => new Response(silentBody()) });
    const timers = fakeTimers();
    const path = dest();
    const pending = download(fetcher, timers.timer, request(path, controller.signal).request);
    await until(() => existsSync(path), "the body to be read");
    controller.abort();
    await assert.rejects(pending, SetupCancelled);
  });
});
