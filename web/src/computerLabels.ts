import { ApiError, type ComputerResource } from "./api.ts";

export const PROFILE_NAMES: Record<string, string> = { terminal: "Terminal", browser: "Browser", desktop: "Desktop" };
export const RUNTIME_NAMES: Record<string, string> = { docker: "Docker" };
export const ENGINE_NAMES: Record<string, string> = { "docker-desktop": "Docker Desktop", orbstack: "OrbStack" };
export const STATUS_NAMES: Record<string, string> = { missing: "Not installed", stopped: "Stopped", unsupported: "Unsupported", ready: "Ready", "check-failed": "Check failed" };
export const SHARED_STATE = "files, browser cookies, running programs and the live screen";

export function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Hive didn't answer.";
}

export function memberNames(resource: ComputerResource, exceptId?: string): string {
  const names = resource.members.filter((member) => member.agentId !== exceptId).map((member) => member.name);
  return names.length > 0 ? names.join(", ") : "no other agents";
}

export function shareSentence(resource: ComputerResource, agentId: string): string {
  const others = resource.members.some((member) => member.agentId !== agentId);
  return others ? `It will share the ${SHARED_STATE} with ${memberNames(resource, agentId)}.` : "No other agent uses it yet.";
}
