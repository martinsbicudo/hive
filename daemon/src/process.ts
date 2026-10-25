import { accessSync, constants } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const SEARCH_PATHS = [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

export function findBinary(name: string): string | null {
  for (const dir of SEARCH_PATHS) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

const SECRET_VARIABLES: ReadonlySet<string> = new Set([
  "HIVE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "CLAUDE_CODE_USE_POWERSHELL_TOOL",
]);

export function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_VARIABLES.has(name) && !name.startsWith("HIVE_SECRET")));
}

export function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const user = process.env.USER ?? userInfo().username;
  return {
    ...withoutSecrets(process.env),
    USER: user,
    LOGNAME: process.env.LOGNAME ?? user,
    HOME: process.env.HOME ?? homedir(),
    PATH: [...SEARCH_PATHS, process.env.PATH ?? ""].filter(Boolean).join(":"),
    ...extra,
  };
}

export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString("utf8");
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      onLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  };
}
