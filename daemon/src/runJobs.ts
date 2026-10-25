import type { Store } from "./db.ts";
import type { StoredAgent } from "./runPlan.ts";
import type { RunContext, TriggerContext } from "./runTokens.ts";
import { agentMessagePrompt, taskRunPrompt } from "./taskPrompt.ts";

const REPLY_LIMIT = 20_000;

export type RunEntry =
  | { kind: "chat"; text: string; from: { agentId: string; untrusted: boolean } | null; context: TriggerContext }
  | { kind: "task"; taskId: string; context: TriggerContext };

export interface RunJob {
  prompt: string;
  sessionId: string | null;
  untrusted: boolean;
  taskId: string | null;
  saveSession(id: string): void;
  forgetSession(): void;
  taintSession(id: string): void;
  reply(text: string, context: Pick<RunContext, "tainted" | "launchedVirtual">): void;
  tool(detail: string): void;
}

export interface JobEvents {
  message(agentId: string): void;
  task(taskId: string): void;
}

export class RunJobs {
  private readonly store: Store;
  private readonly events: JobEvents;

  constructor(store: Store, events: JobEvents) {
    this.store = store;
    this.events = events;
  }

  nameOf(agentId: string): string {
    return this.store.getAgent(agentId)?.name ?? "a deleted agent";
  }

  prepare(agent: StoredAgent, entry: RunEntry, nonce: string): RunJob | null {
    return entry.kind === "chat" ? this.chat(agent, entry, nonce) : this.task(agent, entry.taskId, nonce);
  }

  chatChanged(agentId: string): void {
    this.events.message(agentId);
  }

  notice(agentId: string, entry: RunEntry, message: string): void {
    this.store.addMessage(agentId, "error", message, new Date().toISOString());
    this.events.message(agentId);
    if (entry.kind !== "task") return;
    this.system(entry.taskId, `${this.nameOf(agentId)}'s run on this task ended early. Its chat shows why.`);
  }

  system(taskId: string, text: string): void {
    this.store.tasks.addEvent({ taskId, author: "system", kind: "comment", text, untrusted: false, authorMac: false, gate: null }, new Date().toISOString());
    this.events.task(taskId);
  }

  private chat(agent: StoredAgent, entry: Extract<RunEntry, { kind: "chat" }>, nonce: string): RunJob {
    const built = entry.from ? agentMessagePrompt(this.nameOf(entry.from.agentId), entry.text, entry.from.untrusted, nonce) : { prompt: entry.text, untrusted: false };
    const now = () => new Date().toISOString();
    return {
      prompt: built.prompt,
      sessionId: agent.sessionId,
      untrusted: built.untrusted || this.store.tasks.isSessionTainted(agent.sessionId),
      taskId: null,
      saveSession: (id) => this.store.updateAgent(agent.id, { sessionId: id }, now()),
      forgetSession: () => this.store.updateAgent(agent.id, { sessionId: null }, now()),
      taintSession: (id) => this.store.tasks.taintSession(agent.id, id),
      reply: (text) => this.chatMessage(agent.id, "assistant", text),
      tool: (detail) => this.chatMessage(agent.id, "tool", detail),
    };
  }

  private task(agent: StoredAgent, taskId: string, nonce: string): RunJob | null {
    const tasks = this.store.tasks;
    const task = tasks.getTask(taskId);
    if (!task || task.assigneeId !== agent.id) return null;
    const sessionId = tasks.session(taskId, agent.id);
    const viewer = { id: agent.id, engine: agent.engine, virtual: agent.computer === "virtual" };
    const built = taskRunPrompt(task, tasks.listEvents(taskId), viewer, nonce, (id) => this.nameOf(id));
    return {
      prompt: built.prompt,
      sessionId,
      untrusted: built.untrusted || tasks.isSessionTainted(sessionId),
      taskId,
      saveSession: (id) => tasks.setSession(taskId, agent.id, id),
      forgetSession: () => tasks.deleteSession(taskId, agent.id),
      taintSession: (id) => tasks.taintSession(agent.id, id),
      reply: (text, context) => {
        const reply = {
          taskId, author: agent.id, kind: "comment" as const, text: text.slice(0, REPLY_LIMIT),
          untrusted: context.tainted, authorMac: !context.launchedVirtual, gate: null,
        };
        tasks.addEvent(reply, new Date().toISOString());
        this.events.task(taskId);
      },
      tool: () => undefined,
    };
  }

  private chatMessage(agentId: string, role: "assistant" | "tool", text: string): void {
    this.store.addMessage(agentId, role, text, new Date().toISOString());
    this.events.message(agentId);
  }
}
