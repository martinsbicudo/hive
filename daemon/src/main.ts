import { fileURLToPath } from "node:url";
import { knownComputerIds } from "./computerManagementHelpers.ts";
import { ComputerService } from "./computerService.ts";
import { Store } from "./db.ts";
import { Hub } from "./hub.ts";
import { log } from "./log.ts";
import { limitsFromEnv } from "./loopGuard.ts";
import { claimHome, isAlive as isRunning, processStart, releaseHome } from "./homeLock.ts";
import { dataDir, dbPath, DEFAULT_PORT, ensureDirs, loadOrCreateInstanceId, loadOrCreateToken } from "./paths.ts";
import { readUiSecret } from "./secret.ts";
import { startServer } from "./server.ts";

async function uiSecret(): Promise<string> {
  if (process.env.HIVE_SECRET_STDIN !== "1") return loadOrCreateToken();
  try {
    return await readUiSecret(process.stdin);
  } catch (error) {
    log(`couldn't read the UI secret: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

ensureDirs();
const HOME_WAIT_MS = 8000;
const claimed = await claimHome(dataDir, { pid: process.pid, alive: isRunning, startOf: processStart, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), waitMs: HOME_WAIT_MS });
if (!claimed) {
  log(`another Hive daemon is using ${dataDir}; this one stops without touching it (if no Hive daemon runs, remove ${dataDir}/daemon.lock)`);
  process.exit(1);
}
process.on("exit", () => releaseHome(dataDir, process.pid));
const port = Number(process.env.HIVE_PORT) || DEFAULT_PORT;
const secret = await uiSecret();
const store = new Store(dbPath);
const hub = new Hub(store, {
  command: process.execPath,
  args: [fileURLToPath(new URL("./mcp/hive-mcp.ts", import.meta.url))],
  url: `http://127.0.0.1:${port}`,
}, new ComputerService({ instanceId: loadOrCreateInstanceId() }), { limits: limitsFromEnv(process.env) });
await hub.computers.reconcile(knownComputerIds(store));
hub.computers.clearStagedExports();
await hub.engineSetup.cleanup().catch((error: unknown) => log(`engine setup cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
const webDir = process.env.HIVE_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const server = startServer({ hub, uiSecret: secret, port, webDir });
hub.startScheduler();

const IDLE_CHECK_MS = 60_000;
const idleTimer = setInterval(() => void hub.computers.stopIdle(), IDLE_CHECK_MS);
idleTimer.unref();

server.on("error", (error) => {
  log(`server error: ${error.message}`);
  void shutdown("server error", 1);
});

let stopping = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}, stopping`);
  clearInterval(idleTimer);
  server.close();
  await hub.shutdown();
  store.close();
  process.exit(exitCode);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const PARENT_CHECK_MS = 5000;
const parentPid = Number(process.env.HIVE_PARENT_PID);
if (parentPid > 0) {
  setInterval(() => {
    if (!isAlive(parentPid)) shutdown("parent exit");
  }, PARENT_CHECK_MS).unref();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
