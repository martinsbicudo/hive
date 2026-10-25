import type { ComputerMode, TaskGate } from "./types.ts";

export type GateReason = TaskGate;

export interface GateCaller {
  virtual: boolean;
  tainted: boolean;
}

export interface GateParty {
  id: string;
  name: string;
  computer: ComputerMode;
}

export interface GateEffect {
  reason: GateReason;
  party: GateParty;
}

export const SUMMARY_CAP = 8000;

export function gateFor(caller: GateCaller, runTarget: GateParty | null, viewers: readonly GateParty[]): GateEffect[] {
  const effects: GateEffect[] = [];
  if (caller.tainted && runTarget !== null && runTarget.computer !== "virtual") effects.push({ reason: "tainted-to-mac", party: runTarget });
  if (!caller.virtual) {
    const seen = new Set<string>();
    for (const viewer of viewers) {
      if (viewer.computer !== "virtual" || seen.has(viewer.id)) continue;
      seen.add(viewer.id);
      effects.push({ reason: "mac-to-virtual", party: viewer });
    }
  }
  return effects;
}

export function eventGate(effects: readonly { reason: GateReason }[]): GateReason | null {
  if (effects.some((effect) => effect.reason === "mac-to-virtual")) return "mac-to-virtual";
  return effects[0]?.reason ?? null;
}

export function effectKey(effects: readonly { reason: GateReason; partyId: string }[]): string {
  return effects.map((effect) => `${effect.reason}:${effect.partyId}`).sort().join(",");
}

export function gateSummary(effects: readonly GateEffect[], callerName: string, what: string): string {
  const runs = names(effects, "tainted-to-mac");
  const sees = names(effects, "mac-to-virtual");
  if (runs && sees) return `${callerName} wants ${runs} to: ${what}. ${sees} (virtual computer) will see it too.`;
  if (runs) return `${callerName} wants ${runs} to: ${what}`;
  return `${callerName} wants to send ${sees} (virtual computer): ${what}`;
}

function names(effects: readonly GateEffect[], reason: GateReason): string {
  return effects.filter((effect) => effect.reason === reason).map((effect) => effect.party.name).join(" and ");
}
