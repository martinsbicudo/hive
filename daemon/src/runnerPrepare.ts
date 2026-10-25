import type { RunPlan } from "./engines.ts";
import type { RunEntry, RunJob, RunJobs } from "./runJobs.ts";
import { buildRunPlan, type McpLaunch, type StoredAgent } from "./runPlan.ts";
import { USER_TRIGGER, type ComputerRunBinding, type RunContext, type RunTokens } from "./runTokens.ts";
import { newNonce } from "./trust.ts";

export interface PreparedRun {
  job: RunJob;
  context: RunContext;
  token: string | null;
  plan: RunPlan;
}

export function prepareRun(
  agent: StoredAgent,
  entry: RunEntry,
  binding: ComputerRunBinding | null,
  jobs: RunJobs,
  tokens: RunTokens,
  mcp: McpLaunch,
  onFailure: (agentId: string, entry: RunEntry, reason: string) => void,
): PreparedRun | null {
  let token: string | null = null;
  try {
    const nonce = newNonce();
    const job = jobs.prepare(agent, entry, nonce);
    if (!job) return null;
    const context: RunContext = {
      ...entry.context, agentId: agent.id, taskId: job.taskId, nonce,
      tainted: entry.context.tainted || job.untrusted || agent.computer === "virtual",
      launchedVirtual: agent.computer === "virtual", launchedConnectors: [...agent.connectors],
      computerId: binding?.computerId ?? null, computerRevision: binding?.computerRevision ?? null,
      computerRuntime: binding?.computerRuntime ?? null, computerProfile: binding?.computerProfile ?? null,
      computerLeaseId: binding?.computerLeaseId ?? null,
    };
    token = agent.engine === "claude-code" ? tokens.issue(agent.id, context) : null;
    return { job, context, token, plan: buildRunPlan(agent, job.prompt, token, mcp, job.sessionId, context.tainted, binding?.sharedWith) };
  } catch (error) {
    if (token) tokens.revoke(token);
    onFailure(agent.id, entry, `Hive couldn't start this run: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
