import { request } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { computerShapes, type ComputerRoute } from "../computerInput.ts";

export interface HiveLink {
  url: string;
  token: string;
  waitForApproval: (id: string) => Promise<string>;
}

interface Reply {
  status: number;
  body: unknown;
}

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Object.entries(value).find(([name]) => name === key)?.[1] : undefined;
}

function post(link: HiveLink, route: ComputerRoute, body: Record<string, unknown>): Promise<Reply> {
  const payload = JSON.stringify(body);
  const target = new URL(`/internal/computer/${route}`, link.url);
  return new Promise((resolve, reject) => {
    const outgoing = request(target, {
      method: "POST",
      headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          parsed = null;
        }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

function text(value: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text: value }], isError } : { content: [{ type: "text", text: value }] };
}

function refused(reply: Reply): ToolResult {
  return text(`Hive refused this (${reply.status}): ${String(field(reply.body, "error") ?? "unknown error")}`, true);
}

function unreachable(error: unknown): ToolResult {
  return text(`Hive isn't reachable (${String(error)}).`, true);
}

async function call(link: HiveLink, route: ComputerRoute, body: Record<string, unknown>, render: (reply: unknown) => ToolResult): Promise<ToolResult> {
  try {
    const reply = await post(link, route, body);
    return reply.status === 200 ? render(reply.body) : refused(reply);
  } catch (error) {
    return unreachable(error);
  }
}

const done = () => text("Done.");

function exported(reply: unknown): ToolResult {
  return text(`Exported to ${String(field(reply, "path"))} (${String(field(reply, "bytes"))} bytes).`);
}

async function exportFile(link: HiveLink, path: string): Promise<ToolResult> {
  try {
    const first = await post(link, "export", { path });
    if (first.status !== 200) return refused(first);
    const approvalId = field(first.body, "approvalId");
    if (typeof approvalId !== "string") return exported(first.body);
    if ((await link.waitForApproval(approvalId)) !== "allowed") {
      return text("The user didn't approve this export. Don't retry it unless they ask.", true);
    }
    return call(link, "export", { path }, exported);
  } catch (error) {
    return unreachable(error);
  }
}

export function registerComputerTools(server: McpServer, link: HiveLink): void {
  server.registerTool("computer_run", {
    description: "Runs a bash command on your virtual Linux computer (as the agent user, in ~/workspace). Returns the exit code and output (last 30 kB).",
    inputSchema: computerShapes.run,
  }, ({ command, timeout_s }) => call(link, "run", { command, timeout_s }, (reply) => text(`exit ${String(field(reply, "exitCode"))}\n${String(field(reply, "output") ?? "")}`)));

  server.registerTool("computer_screenshot", {
    description: "Takes a screenshot of your virtual computer's desktop (1440x900).",
    inputSchema: computerShapes.screenshot,
  }, () => call(link, "screenshot", {}, (reply) => ({ content: [{ type: "image", data: String(field(reply, "data") ?? ""), mimeType: "image/png" }] })));

  server.registerTool("computer_click", {
    description: "Moves the mouse to (x, y) on the desktop and clicks.",
    inputSchema: computerShapes.click,
  }, ({ x, y, button }) => call(link, "click", { x, y, button }, done));

  server.registerTool("computer_type", {
    description: "Types text into the focused window on the desktop.",
    inputSchema: computerShapes.type,
  }, ({ text: typed }) => call(link, "type", { text: typed }, done));

  server.registerTool("computer_key", {
    description: "Presses keys on the desktop, e.g. 'Return', 'ctrl+l', 'alt+Tab'.",
    inputSchema: computerShapes.key,
  }, ({ keys }) => call(link, "key", { keys }, done));

  server.registerTool("computer_open", {
    description: "Opens an http(s) URL in Chromium on the desktop.",
    inputSchema: computerShapes.open,
  }, ({ url }) => call(link, "open", { url }, done));

  server.registerTool("computer_read_file", {
    description: "Reads a text file on your virtual computer (up to 200 kB).",
    inputSchema: computerShapes.read,
  }, ({ path }) => call(link, "read", { path }, (reply) => text(`${String(field(reply, "text") ?? "")}${field(reply, "truncated") === true ? "\n[truncated at 200 kB]" : ""}`)));

  server.registerTool("computer_write_file", {
    description: "Writes a text file on your virtual computer, creating folders as needed.",
    inputSchema: computerShapes.write,
  }, ({ path, content }) => call(link, "write", { path, content }, (reply) => text(`Wrote ${String(field(reply, "bytes"))} bytes to ${String(field(reply, "path"))}.`)));

  server.registerTool("computer_export", {
    description: "Copies one file from your virtual computer to the user's Mac (~/Downloads/Hive). The user approves every export.",
    inputSchema: computerShapes.export,
  }, ({ path }) => exportFile(link, path));
}
