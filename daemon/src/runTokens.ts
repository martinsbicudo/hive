import { createHash, randomBytes } from "node:crypto";
import { newNonce } from "./trust.ts";
import type { ComputerProfile, ComputerRuntime } from "./computerTypes.ts";
import type { Connector } from "./types.ts";

export type Origin = "user" | string;

export interface TriggerContext {
  hop: number;
  origin: Origin;
  tainted: boolean;
}

export interface RunContext extends TriggerContext {
  agentId: string;
  taskId: string | null;
  nonce: string;
  launchedVirtual: boolean;
  launchedConnectors: readonly Connector[];
  computerId: string | null;
  computerRevision: number | null;
  computerRuntime: ComputerRuntime | null;
  computerProfile: ComputerProfile | null;
  computerLeaseId: string | null;
}

export interface ComputerRunBinding {
  computerId: string;
  computerRevision: number;
  computerRuntime: ComputerRuntime;
  computerProfile: ComputerProfile;
  computerLeaseId: string;
  sharedWith?: readonly string[];
}

export function readExternalOnMac(context: RunContext | null): boolean {
  return context !== null && context.tainted && !context.launchedVirtual;
}

export const USER_TRIGGER: TriggerContext = { hop: 0, origin: "user", tainted: false };

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class RunTokens {
  private readonly runs = new Map<string, RunContext>();

  issue(agentId: string, context: RunContext = {
    ...USER_TRIGGER, agentId, taskId: null, nonce: newNonce(), launchedVirtual: false, launchedConnectors: [],
    computerId: null, computerRevision: null, computerRuntime: null, computerProfile: null, computerLeaseId: null,
  }): string {
    if (context.agentId !== agentId) throw new Error("a run token must belong to its run's agent");
    const token = randomBytes(32).toString("hex");
    this.runs.set(digest(token), context);
    return token;
  }

  resolve(token: string | null): string | null {
    return this.context(token)?.agentId ?? null;
  }

  context(token: string | null): RunContext | null {
    if (!token) return null;
    return this.runs.get(digest(token)) ?? null;
  }

  revoke(token: string): void {
    this.runs.delete(digest(token));
  }
}
