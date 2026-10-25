import type { ComputerProfile } from "./computerTypes.ts";

export const AGENT_LABEL = "hive.agent";
export const ROLE_LABEL = "hive.role";
export const INSTANCE_LABEL = "hive.instance";
export const SCREEN_PORT = 6080;
export const AGENT_UID = 1000;
export const VNC_UID = 1001;
export const COMMAND_TIMEOUT_MAX_S = 600;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class InvalidAgentIdError extends Error {}

export interface ComputerNames {
  agent: string;
  holder: string;
  network: string;
  volume: string;
}

export function namesFor(agentId: string): ComputerNames {
  if (!UUID.test(agentId)) throw new InvalidAgentIdError(`not an agent id: ${agentId}`);
  return { agent: `hive-${agentId}`, holder: `hive-netns-${agentId}`, network: `hive-net-${agentId}`, volume: `hive-home-${agentId}` };
}

export interface Images {
  computer: string;
  netns: string;
  profiles?: Partial<Record<ComputerProfile, string>>;
}

export function ownerLabels(agentId: string, instanceId: string): string[] {
  namesFor(agentId);
  if (!UUID.test(instanceId)) throw new InvalidAgentIdError(`not a Hive instance id: ${instanceId}`);
  return ["--label", `${AGENT_LABEL}=${agentId}`, "--label", `${INSTANCE_LABEL}=${instanceId}`];
}

export function networkCreateArgs(agentId: string, instanceId: string): string[] {
  return ["network", "create", "--driver", "bridge", ...ownerLabels(agentId, instanceId), namesFor(agentId).network];
}

export function volumeCreateArgs(agentId: string, instanceId: string): string[] {
  return ["volume", "create", ...ownerLabels(agentId, instanceId), namesFor(agentId).volume];
}

export function holderRunArgs(computerId: string, images: Images, instanceId: string, profile: ComputerProfile = "desktop"): string[] {
  const names = namesFor(computerId);
  const args = [
    "run", "-d", "--name", names.holder,
    ...ownerLabels(computerId, instanceId), "--label", `${ROLE_LABEL}=netns`,
    "--network", names.network,
    "--cap-drop", "ALL", "--cap-add", "NET_ADMIN",
    "--security-opt", "no-new-privileges",
    "--read-only", "--pids-limit", "32", "--memory", "64m",
    images.netns,
  ];
  if (profile !== "terminal") args.splice(args.length - 1, 0, "-p", `127.0.0.1::${SCREEN_PORT}`);
  return args;
}

export function agentRunArgs(computerId: string, images: Images, instanceId: string, profile: ComputerProfile = "desktop"): string[] {
  const names = namesFor(computerId);
  const args = [
    "run", "-d", "--name", names.agent,
    ...ownerLabels(computerId, instanceId), "--label", `${ROLE_LABEL}=computer`,
    "--network", `container:${names.holder}`,
    "--user", "agent", "--init",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "512", "--memory", "4g", "--cpus", "2",
    "--read-only",
    "--tmpfs", "/tmp:mode=1777",
    "-v", `${names.volume}:/home/agent`,
    images.profiles?.[profile] ?? images.computer,
  ];
  if (profile !== "terminal") args.splice(args.length - 3, 0, "--tmpfs", `/run/vnc:uid=${VNC_UID},gid=${VNC_UID},mode=0700`);
  return args;
}

export function execArgs(agentId: string, user: "agent" | "vnc", command: readonly string[], options: { detach?: boolean; stdin?: boolean } = {}): string[] {
  const names = namesFor(agentId);
  const args = ["exec"];
  if (options.detach) args.push("-d");
  if (options.stdin) args.push("-i");
  args.push("-u", user, "-w", user === "agent" ? "/home/agent/workspace" : "/", names.agent, ...command);
  return args;
}

export function commandArgv(command: string, timeoutS: number): string[] {
  const seconds = Math.min(COMMAND_TIMEOUT_MAX_S, Math.max(1, Math.floor(timeoutS)));
  return ["timeout", "-s", "KILL", String(seconds), "bash", "-lc", command];
}
