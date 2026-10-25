import { readFileSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SCREEN_PREFIX = "/screen/";

export const SCREEN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src ws://127.0.0.1:*",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const PAGE_FILES: Record<string, string> = { "": "index.html", "index.html": "index.html", "screen.js": "screen.js", "screen.css": "screen.css", "params.js": "params.js" };
const NOVNC_PREFIX = "novnc/";
const NOVNC_FOLDERS = ["core", "vendor"];
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const pageDir = fileURLToPath(new URL("../screen/", import.meta.url));
const novncDir = dirname(dirname(fileURLToPath(import.meta.resolve("@novnc/novnc"))));

const HEADERS = {
  "content-security-policy": SCREEN_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "clipboard-read=(), clipboard-write=(), camera=(), microphone=(), geolocation=()",
  "cache-control": "no-store",
};

function novncFile(relative: string): string | null {
  if (extname(relative) !== ".js" || !NOVNC_FOLDERS.some((folder) => relative.startsWith(`${folder}/`))) return null;
  const root = realpathSync(novncDir);
  const requested = resolve(root, relative);
  if (!requested.startsWith(root + sep)) return null;
  try {
    const real = realpathSync(requested);
    return real.startsWith(root + sep) && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function rawPath(requestUrl: string): string {
  const end = requestUrl.search(/[?#]/);
  return end === -1 ? requestUrl : requestUrl.slice(0, end);
}

export function isScreenPath(raw: string): boolean {
  return raw.startsWith("/screen");
}

export function screenFile(pathname: string): string | null {
  if (!pathname.startsWith(SCREEN_PREFIX)) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(SCREEN_PREFIX.length));
  } catch {
    return null;
  }
  if (relative.includes("\0") || relative.includes("\\")) return null;
  const page = PAGE_FILES[relative];
  if (page !== undefined) return join(pageDir, page);
  return relative.startsWith(NOVNC_PREFIX) ? novncFile(relative.slice(NOVNC_PREFIX.length)) : null;
}

export function serveScreen(response: ServerResponse, pathname: string, method: string): void {
  if (pathname === "/screen") {
    response.writeHead(308, { ...HEADERS, location: SCREEN_PREFIX });
    return void response.end();
  }
  const file = method === "GET" || method === "HEAD" ? screenFile(pathname) : null;
  if (file === null) {
    response.writeHead(404, { ...HEADERS, "content-type": "text/plain; charset=utf-8" });
    return void response.end("not found");
  }
  response.writeHead(200, { ...HEADERS, "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  response.end(method === "HEAD" ? undefined : readFileSync(file));
}
