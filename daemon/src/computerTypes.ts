export type ComputerMode = "mac" | "virtual";
export type ComputerRuntime = "docker";
export type ComputerProfile = "terminal" | "browser" | "desktop";
export type ComputerEngine = "docker-desktop" | "orbstack";

export interface Computer {
  id: string;
  name: string;
  runtime: ComputerRuntime;
  profile: ComputerProfile;
  engine: ComputerEngine | null;
  revision: number;
  managed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ComputerMember {
  agentId: string;
  name: string;
}

export interface ComputerResource extends Computer {
  members: ComputerMember[];
}

export interface ComputerStatus {
  state: ComputerState;
  detail?: string;
  computerId?: string;
  profile?: ComputerProfile;
  hasScreen?: boolean;
}

export type ComputerState = "missing" | "building" | "stopped" | "starting" | "running" | "error";
