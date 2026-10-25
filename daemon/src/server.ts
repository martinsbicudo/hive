import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { ValidationError } from "./agents.ts";
import { architectApi } from "./architectRoutes.ts";
import { allowedHost, allowedOrigin, authorize, bearerToken, singleHost, socketToken } from "./auth.ts";
import { avatarPng, avatarSvg } from "./avatars.ts";
import { computerApi, computerAssignmentApi, computerCollectionApi, computerMoveEngineApi, computerResourceApi, computerRuntimesApi, internalComputer } from "./computerRoutes.ts";
import { controlApi } from "./controlRoutes.ts";
import { engineSetupApi } from "./engineSetupRoutes.ts";
import { healthReply } from "./health.ts";
import { HttpError } from "./httpError.ts";
import { NotFoundError, type Hub } from "./hub.ts";
import { log } from "./log.ts";
import { requestUrl } from "./requestTarget.ts";
import { isScreenPath, rawPath, serveScreen } from "./screenPage.ts";
import { internalTasks, taskApi } from "./taskRoutes.ts";
import { TEMPLATES } from "./templates.ts";

const MAX_BODY = 256 * 1024;
const MAX_COMPUTER_BODY = 1024 * 1024;
const APPROVAL_POLL_MS = 25_000;
const MESSAGE_PAGE = 200;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon",
};

export interface ServerOptions {
  hub: Hub;
  uiSecret: string;
  port: number;
  webDir: string;
}

async function readJson(request: IncomingMessage, maxBytes = MAX_BODY): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "body too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "expected a JSON object");
  return Object.fromEntries(Object.entries(parsed));
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function serveStatic(response: ServerResponse, webDir: string, pathname: string): void {
  const root = resolve(webDir);
  const requested = resolve(join(root, normalize(decodeURIComponent(pathname))));
  const insideRoot = requested === root || requested.startsWith(root + sep);
  const file = insideRoot && existsSync(requested) && statSync(requested).isFile() ? requested : join(root, "index.html");
  if (!existsSync(file)) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Board UI isn't built yet. Run `make web`.");
    return;
  }
  response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": BOARD_CSP });
  response.end(readFileSync(file));
}

function refuse(socket: Duplex, status: string): void {
  if (socket.writable) socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function inputOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

const BOARD_CSP = "script-src 'self'";

export function startServer({ hub, uiSecret, port, webDir }: ServerOptions): Server {
  const sockets = new WebSocketServer({ noServer: true });
  const credentials = { uiSecret, runTokens: hub.runTokens };

  const internal = async (request: IncomingMessage, response: ServerResponse, parts: string[]): Promise<void> => {
    const token = bearerToken(request);
    const access = authorize("internal", token, credentials);
    if (access?.kind !== "run") throw new HttpError(401, "missing or wrong token");
    const method = request.method ?? "GET";
    const runContext = () => {
      const context = hub.runTokens.context(token);
      if (context?.agentId !== access.agentId) throw new HttpError(401, "missing or wrong token");
      return context;
    };
    if (parts[1] === "tasks" && method === "POST" && parts.length === 3) {
      return send(response, 200, await internalTasks(hub, runContext(), parts[2], await readJson(request)));
    }
    if (parts[1] === "connectors" && method === "POST" && parts.length === 3) {
      return send(response, 200, await hub.connectorCall(runContext(), parts[2], await readJson(request)));
    }
    if (parts[1] === "approvals" && method === "POST" && parts.length === 2) {
      const context = runContext();
      const body = await readJson(request);
      const toolName = typeof body.toolName === "string" ? body.toolName : "";
      if (!toolName) throw new HttpError(400, "toolName is required");
      return send(response, 200, hub.requestApproval(access.agentId, toolName, inputOf(body.input), context));
    }
    if (parts[1] === "approvals" && method === "GET" && parts[2] && parts[3] === "wait" && parts.length === 4) {
      return send(response, 200, { status: await hub.waitForApproval(access.agentId, parts[2], APPROVAL_POLL_MS) });
    }
    if (parts[1] === "computer" && method === "POST" && parts.length === 3) {
      return send(response, 200, await internalComputer(hub, runContext(), parts[2], await readJson(request, MAX_COMPUTER_BODY)));
    }
    throw new HttpError(404, "not found");
  };

  const route = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const method = request.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "screen") return serveScreen(response, rawPath(request.url ?? "/"), method);
    if (url.pathname === "/health") return send(response, 200, healthReply(url.searchParams, uiSecret));

    if (url.pathname === "/avatars/preview.svg" && method === "GET") {
      const style = url.searchParams.get("style") ?? "";
      const seed = (url.searchParams.get("seed") ?? "Hive").slice(0, 80);
      response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      return void response.end(avatarSvg(style, seed));
    }

    if (parts[0] === "avatars" && parts[1] && method === "GET") {
      const [id, extension] = parts[1].split(".");
      const agent = hub.agent(id ?? "");
      if (extension === "png") {
        const size = Math.min(512, Math.max(16, Number(url.searchParams.get("size")) || 128));
        response.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=60" });
        return void response.end(avatarPng(agent.avatarStyle, agent.avatarSeed, size));
      }
      response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=60" });
      return void response.end(avatarSvg(agent.avatarStyle, agent.avatarSeed));
    }

    if (parts[0] === "internal") return internal(request, response, parts);
    if (parts[0] !== "api") return serveStatic(response, webDir, url.pathname);

    if (authorize("ui", bearerToken(request), credentials)?.kind !== "ui") throw new HttpError(401, "missing or wrong token");

    const [, resource, id, action, detail] = parts;
    const architect = await architectApi(hub, method, parts, () => readJson(request));
    if (architect) return send(response, architect.status, architect.body);
    const control = await controlApi(hub, method, parts, () => readJson(request));
    if (control) return send(response, control.status, control.body);
    if (resource === "state" && method === "GET") return send(response, 200, hub.state());
    if (resource === "options" && method === "GET") return send(response, 200, hub.options());
    if (resource === "computer-runtimes" && method === "GET" && parts.length === 2) return send(response, 200, await computerRuntimesApi(hub));
    if (resource === "computers") {
      if (id === "setup" && parts.length === 3) {
        const reply = await engineSetupApi(hub.engineSetup, method, () => readJson(request));
        return send(response, reply.status, reply.body);
      }
      if (!id && parts.length === 2) {
        const reply = await computerCollectionApi(hub, method, method === "POST" ? await readJson(request) : {});
        return send(response, reply.status, reply.body);
      }
      if (id && action === "move-engine" && method === "POST" && parts.length === 4) {
        return send(response, 200, await computerMoveEngineApi(hub, id, await readJson(request)));
      }
      if (id && !action && parts.length === 3) {
        const reply = await computerResourceApi(hub, id, method, method === "PATCH" ? await readJson(request) : {});
        return send(response, reply.status, reply.body);
      }
    }
    if (resource === "templates" && method === "GET" && parts.length === 2) return send(response, 200, TEMPLATES);
    if (resource === "agents") {
      if (!id && method === "POST") return send(response, 201, hub.createAgent(await readJson(request)));
      if (id && !action && method === "PATCH") return send(response, 200, hub.updateAgent(id, await readJson(request)));
      if (id && !action && method === "DELETE") {
        await hub.deleteAgent(id);
        return send(response, 200, { ok: true });
      }
      if (id && action === "messages" && method === "GET") return send(response, 200, hub.messages(id, MESSAGE_PAGE));
      if (id && action === "messages" && method === "POST") {
        hub.send(id, (await readJson(request)).text);
        return send(response, 202, { ok: true });
      }
      if (id && action === "stop" && method === "POST") {
        hub.stop(id);
        return send(response, 200, { ok: true });
      }
      if (id && action === "avatar" && method === "POST") return send(response, 200, hub.shuffleAvatar(id));
      if (id && action === "rules" && method === "DELETE" && parts.length === 4) return send(response, 200, hub.removeRule(id, await readJson(request)));
      if (id && action === "computer" && !detail && (method === "PUT" || method === "DELETE")) {
        const reply = await computerAssignmentApi(hub, id, method, method === "PUT" ? await readJson(request) : {});
        return send(response, reply.status, reply.body);
      }
      if (id && action === "computer" && parts.length <= 5) {
        const reply = await computerApi(hub, id, detail, method);
        return send(response, reply.status, reply.body);
      }
    }
    if (resource === "tasks" && parts.length <= 4) {
      const reply = await taskApi(hub, method, id, action, () => readJson(request));
      return send(response, reply.status, reply.body);
    }
    if (resource === "approvals" && id && method === "POST") {
      const body = await readJson(request);
      return send(response, 200, hub.decideApproval(id, body.allow, body.remember));
    }
    throw new HttpError(404, "not found");
  };

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (!allowedHost(singleHost(request), port)) return send(response, 403, { error: "host not allowed" });
    if (!allowedOrigin(request.headers.origin, port)) return send(response, 403, { error: "origin not allowed" });
    const url = requestUrl(request.url, port);
    if (!url) return send(response, 400, { error: "bad request target" });
    const raw = rawPath(request.url ?? "/");
    if (isScreenPath(raw)) return serveScreen(response, raw, request.method ?? "GET");
    route(request, response, url).catch((error: unknown) => {
      if (error instanceof HttpError) return send(response, error.status, error.code === undefined ? { error: error.message } : { error: error.message, code: error.code });
      if (error instanceof ValidationError) return send(response, 400, { error: error.message });
      if (error instanceof NotFoundError) return send(response, 404, { error: error.message });
      log(`request ${request.method} ${url.pathname} failed: ${String(error)}`);
      send(response, 500, { error: "internal error" });
    });
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!allowedHost(singleHost(request), port)) return refuse(socket, "403 Forbidden");
    const url = requestUrl(request.url, port);
    if (!url) return refuse(socket, "400 Bad Request");
    if (url.pathname !== "/ws" || !allowedOrigin(request.headers.origin, port) || authorize("ui", socketToken(request, url), credentials)?.kind !== "ui") {
      return refuse(socket, "401 Unauthorized");
    }
    sockets.handleUpgrade(request, socket, head, (client: WebSocket) => {
      client.send(JSON.stringify({ type: "state", state: hub.state() }));
      const unsubscribe = hub.subscribe((event) => client.send(JSON.stringify(event)));
      client.on("close", unsubscribe);
    });
  };

  const server = createServer((request, response) => {
    try {
      handleRequest(request, response);
    } catch (error) {
      log(`request ${request.method} failed before routing: ${String(error)}`);
      if (!response.headersSent) send(response, 500, { error: "internal error" });
      else response.destroy();
    }
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", (error) => log(`upgrade socket error: ${error.message}`));
    try {
      handleUpgrade(request, socket, head);
    } catch (error) {
      log(`upgrade failed: ${String(error)}`);
      refuse(socket, "500 Internal Server Error");
    }
  });

  server.listen(port, "127.0.0.1", () => log(`hive daemon listening on http://127.0.0.1:${port}`));
  return server;
}
