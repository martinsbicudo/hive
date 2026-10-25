import { agentFilePath, READ_LIMIT_BYTES } from "./computerInput.ts";
import { ComputerError, LEASE_ENDED, type Computers, type ExecOptions, type LeaseScope } from "./computers.ts";
import type { CommandResult } from "./docker.ts";
import { GuestLeases, type LeaseRef } from "./computerLeaseExec.ts";
import { BROWSER_READY_SCRIPT, BROWSER_SCRIPT, BUTTONS, ComputerToolError, DISPLAY, lastLine, SCREENSHOT_LIMIT_BYTES, WRITE_SCRIPT } from "./computerServiceHelpers.ts";
import { ComputerServiceExports } from "./computerServiceExports.ts";
import type { ComputerConfig, ComputerExportContext, ComputerServiceOptions } from "./computerService.ts";
import type { ExportResult } from "./export.ts";
import type { ExportSnapshot } from "./exportStaging.ts";

export interface GuestHost {
  computerOf(agentId: string): ComputerConfig;
  machineOf(config: ComputerConfig): Computers;
  existingMachine(computerId: string): Computers | undefined;
}

type Scoped = Required<LeaseScope>;

export class ComputerGuest {
  readonly exports: ComputerServiceExports;
  private readonly leases: GuestLeases;
  private readonly host: GuestHost;
  private leaseValidator: ComputerServiceOptions["isLeaseCurrent"];

  constructor(options: ComputerServiceOptions, host: GuestHost) {
    this.host = host;
    this.leaseValidator = options.isLeaseCurrent;
    this.exports = new ComputerServiceExports(options);
    this.leases = new GuestLeases({
      kill: (computerId, leaseId) => host.existingMachine(computerId)?.killLease(computerId, leaseId) ?? Promise.resolve(true),
      stop: async (computerId) => host.existingMachine(computerId)?.stop(computerId),
    });
  }

  setLeaseValidator(validate: NonNullable<ComputerServiceOptions["isLeaseCurrent"]>): void {
    this.leaseValidator = validate;
  }

  revokeLease(lease: LeaseRef): void {
    this.leases.revoke(lease);
  }

  drainLease(lease: LeaseRef): Promise<void> | null {
    this.exports.forgetLease(lease);
    return this.leases.drain(lease);
  }

  run(agentId: string, lease: ComputerExportContext, command: string, timeoutS: number): Promise<{ exitCode: number; output: string }> {
    return this.guest(agentId, lease, (scope) => {
      const config = this.host.computerOf(agentId);
      return this.host.machineOf(config).run(config.id, command, timeoutS, scope);
    });
  }

  screenshot(agentId: string, lease: ComputerExportContext): Promise<string> {
    return this.guest(agentId, lease, async (scope) => {
      this.requireScreen(agentId);
      const result = await this.must(agentId, ["hive-shot"], "the screenshot failed", { ...scope, maxStdoutBytes: SCREENSHOT_LIMIT_BYTES });
      return result.stdout.toString("base64");
    });
  }

  click(agentId: string, lease: ComputerExportContext, x: number, y: number, button: keyof typeof BUTTONS): Promise<void> {
    return this.screenCommand(agentId, lease, ["mousemove", String(x), String(y), "click", BUTTONS[button]], "the click failed");
  }

  type(agentId: string, lease: ComputerExportContext, text: string): Promise<void> {
    return this.screenCommand(agentId, lease, ["type", "--delay", "12", "--file", "-"], "typing failed", text);
  }

  key(agentId: string, lease: ComputerExportContext, keys: readonly string[]): Promise<void> {
    return this.screenCommand(agentId, lease, ["key", ...keys], "the key press failed");
  }

  open(agentId: string, lease: ComputerExportContext, url: string): Promise<void> {
    return this.guest(agentId, lease, async (scope) => {
      if (this.host.computerOf(agentId).profile === "terminal") throw new ComputerToolError("this computer profile has no browser");
      // Chromium is desktop state every member shares, so it isn't started inside the lease's session.
      await this.must(agentId, ["sh", "-c", BROWSER_SCRIPT, "hive-open", url], "the browser didn't open", { current: scope.current, detach: true });
      await this.must(agentId, ["sh", "-c", BROWSER_READY_SCRIPT], "the browser didn't open", scope);
    });
  }

  readFile(agentId: string, lease: ComputerExportContext, path: string): Promise<{ path: string; text: string; truncated: boolean }> {
    return this.guest(agentId, lease, async (scope) => {
      const absolute = agentFilePath(path);
      const result = await this.must(agentId, ["head", "-c", String(READ_LIMIT_BYTES + 1), "--", absolute], "reading failed", scope);
      const truncated = result.stdout.length > READ_LIMIT_BYTES;
      return { path: absolute, text: result.stdout.subarray(0, READ_LIMIT_BYTES).toString("utf8"), truncated };
    });
  }

  writeFile(agentId: string, lease: ComputerExportContext, path: string, content: string): Promise<{ path: string; bytes: number }> {
    return this.guest(agentId, lease, async (scope) => {
      const absolute = agentFilePath(path);
      await this.must(agentId, ["sh", "-c", WRITE_SCRIPT, "hive-write", absolute], "writing failed", { ...scope, input: content });
      return { path: absolute, bytes: Buffer.byteLength(content) };
    });
  }

  exportFile(agentId: string, path: string, lease: ComputerExportContext, ask: (snapshot: ExportSnapshot) => string): Promise<{ approvalId: string } | ExportResult> {
    return this.guest(agentId, lease, (scope) => {
      const config = this.host.computerOf(agentId);
      const exec = (command: readonly string[], options: ExecOptions) => this.host.machineOf(config).exec(config.id, command, { ...options, ...scope });
      return this.exports.exportFile(agentId, path, lease, { current: scope.current, exec }, ask);
    });
  }

  // The check and the in-flight count happen in one synchronous step, so a release can't slip between them.
  private guest<T>(agentId: string, lease: ComputerExportContext, work: (scope: Scoped) => Promise<T>): Promise<T> {
    const current = () => this.leaseValidator?.({ ...lease, agentId }) ?? false;
    if (!current()) return Promise.reject(new ComputerError(LEASE_ENDED));
    const done = this.leases.begin(lease.computerLeaseId);
    try {
      return work({ leaseId: lease.computerLeaseId, current }).finally(done);
    } catch (error) {
      done();
      return Promise.reject(error);
    }
  }

  private screenCommand(agentId: string, lease: ComputerExportContext, xdotool: readonly string[], what: string, input?: string): Promise<void> {
    return this.guest(agentId, lease, async (scope) => {
      this.requireScreen(agentId);
      await this.must(agentId, [...DISPLAY, "xdotool", ...xdotool], what, { ...scope, input });
    });
  }

  private requireScreen(agentId: string): void {
    if (this.host.computerOf(agentId).profile === "terminal") throw new ComputerToolError("this computer profile has no screen");
  }

  private async must(agentId: string, command: readonly string[], what: string, options: ExecOptions): Promise<CommandResult> {
    const config = this.host.computerOf(agentId);
    const result = await this.host.machineOf(config).exec(config.id, command, options);
    if (result.code !== 0 || result.overflowed) throw new ComputerToolError(`${what}: ${lastLine(result)}`);
    return result;
  }
}
