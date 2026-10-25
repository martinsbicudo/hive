import { appendFileSync } from "node:fs";
import { logPath } from "./paths.ts";

export function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(logPath, line);
  } catch (error) {
    process.stderr.write(`log write failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const LINE_LIMIT = 500;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function oneLine(text: string, limit: number = LINE_LIMIT): string {
  const escaped = text.replace(CONTROL, (char) => {
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return escaped.length > limit ? `${escaped.slice(0, limit - 1)}…` : escaped;
}
