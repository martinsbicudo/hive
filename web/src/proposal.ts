import { api, ApiError, type Agent, type AgentForm, type AgentTemplate, type ArchitectProposal, type ProposedSchedule } from "./api.ts";
import { describeSchedule } from "./wake.ts";

export const DEFAULT_AVATAR_STYLE = "notionists";
export const SHORT_INTERVAL_MINUTES = 60;

export function formFromProposal(proposal: ArchitectProposal): AgentForm {
  return {
    name: proposal.name,
    role: proposal.role,
    engine: proposal.engine,
    model: proposal.model,
    instructions: proposal.instructions,
    avatarStyle: proposal.avatarStyle ?? DEFAULT_AVATAR_STYLE,
    useMySetup: false,
    permissionMode: "ask",
    folders: proposal.folders,
    computer: proposal.computer,
    connectors: [],
  };
}

export function formFromTemplate(template: AgentTemplate): AgentForm {
  return {
    name: template.name,
    role: template.role,
    engine: template.engine,
    model: "auto",
    instructions: template.instructions,
    avatarStyle: template.avatar.style,
    useMySetup: false,
    permissionMode: template.permissionMode,
    folders: [],
    computer: template.computer,
    connectors: template.connectors,
  };
}

export function isShortInterval(schedule: ProposedSchedule): boolean {
  return schedule.kind === "interval" && schedule.everyMinutes !== null && schedule.everyMinutes < SHORT_INTERVAL_MINUTES;
}

export interface Created {
  agent: Agent;
  failures: string[];
}

export async function createWithSchedules(form: AgentForm, avatarSeed: string, schedules: readonly ProposedSchedule[]): Promise<Created> {
  const agent = await api.createAgent(form, avatarSeed);
  const failures: string[] = [];
  for (const schedule of schedules) {
    try {
      await api.addSchedule(agent.id, schedule);
    } catch (caught) {
      const reason = caught instanceof ApiError ? caught.message : "Hive didn't answer.";
      failures.push(`${describeSchedule(schedule.kind, schedule.at, schedule.everyMinutes)} (${reason})`);
    }
  }
  return { agent, failures };
}
