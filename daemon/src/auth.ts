import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RunTokens } from "./runTokens.ts";

export type Scope = "ui" | "internal";

export type Access = { kind: "ui" } | { kind: "run"; agentId: string };

export interface Credentials {
  uiSecret: string;
  runTokens: RunTokens;
}

export function sameSecret(given: string | null, secret: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

export function socketToken(request: IncomingMessage, url: URL): string | null {
  return bearerToken(request) ?? url.searchParams.get("token");
}

export function allowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function singleHost(request: IncomingMessage): string | undefined {
  const hosts = request.headersDistinct.host;
  return hosts?.length === 1 ? hosts[0] : undefined;
}

export function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function authorize(scope: Scope, given: string | null, credentials: Credentials): Access | null {
  if (scope === "ui") return sameSecret(given, credentials.uiSecret) ? { kind: "ui" } : null;
  const agentId = credentials.runTokens.resolve(given);
  return agentId ? { kind: "run", agentId } : null;
}
