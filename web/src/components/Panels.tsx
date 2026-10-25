import { api, avatarUrl, ENGINE_NAMES, formatTokens, formatUsd, type Agent, type HubState } from "../api.ts";
import { formatWake } from "../wake.ts";
import { BudgetsPanel } from "./Budgets.tsx";
import { OutwardCard } from "./OutwardCard.tsx";

export function ApprovalsBar({ state }: { state: HubState }) {
  if (state.approvals.length === 0) return null;
  const agents = new Map(state.agents.map((agent) => [agent.id, agent]));
  return (
    <section className="approvals" aria-label="Pending approvals">
      {state.approvals.map((approval) => {
        const agent = agents.get(approval.agentId);
        return (
          <div key={approval.id} className="approval">
            {agent && <img className="avatar sm" src={avatarUrl(agent)} alt="" />}
            <div className="approval-text">
              {approval.display ? (
                <OutwardCard agentName={approval.agentName} display={approval.display} />
              ) : approval.targetAgentId ? (
                <p className="gate-summary">{approval.summary}</p>
              ) : (
                <>
                  <strong>{approval.agentName}</strong> wants to run
                  <code>{approval.summary}</code>
                </>
              )}
              {approval.tainted && <p className="taint-warning">This run read external content.</p>}
            </div>
            <div className="actions">
              <button className="ghost" onClick={() => void api.decide(approval.id, false)}>Deny</button>
              {approval.rememberable && (
                <button className="ghost" onClick={() => void api.decide(approval.id, true, true)} title="Allow this kind of action from now on">Always allow</button>
              )}
              <button className="primary" onClick={() => void api.decide(approval.id, true)}>Allow</button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function UsageView({ state, connected }: { state: HubState; connected: boolean }) {
  if (state.usage.length === 0 && !state.architectUsage) return <div className="empty"><p>No agents yet, so nothing has been spent.</p></div>;
  return (
    <section className="usage">
      <h2>Usage</h2>
      <p className="muted">Claude Code reports cost per run (what the same usage would cost on the API; on a plan it counts toward your limits). Codex reports tokens only.</p>
      <div className="cards">
        {state.usage.map((usage) => (
          <article key={usage.engine} className="card">
            <h3>{ENGINE_NAMES[usage.engine]}</h3>
            <p className="muted">{usage.agents} agent{usage.agents === 1 ? "" : "s"} · {usage.activeRuns} running now</p>
            {usage.engine === "claude-code" ? (
              <dl>
                <div><dt>Today</dt><dd>{formatUsd(usage.todayUsd)}</dd></div>
                <div><dt>7 days</dt><dd>{formatUsd(usage.weekUsd)}</dd></div>
                <div><dt>This month</dt><dd>{formatUsd(usage.monthUsd)}</dd></div>
              </dl>
            ) : (
              <dl><div><dt>Tokens today</dt><dd>{formatTokens(usage.todayTokens)}</dd></div></dl>
            )}
          </article>
        ))}
        {state.architectUsage && (
          <article className="card">
            <h3>Architect</h3>
            <p className="muted">Claude Code · new-agent chats</p>
            <dl>
              <div><dt>Today</dt><dd>{formatUsd(state.architectUsage.todayUsd)}</dd></div>
              <div><dt>7 days</dt><dd>{formatUsd(state.architectUsage.weekUsd)}</dd></div>
              <div><dt>This month</dt><dd>{formatUsd(state.architectUsage.monthUsd)}</dd></div>
            </dl>
          </article>
        )}
      </div>
      <BudgetsPanel state={state} connected={connected} />
    </section>
  );
}

export function AgentRow({ agent, selected, onSelect }: { agent: Agent; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`agent-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <span className="avatar-wrap">
        <img className="avatar md" src={avatarUrl(agent)} alt="" />
        <span className={`dot ${agent.status}`} />
      </span>
      <span className="agent-text">
        <span className="name">{agent.name}</span>
        <span className="role">{agent.role}</span>
        {agent.nextWake && <span className="wake">Next wake {formatWake(agent.nextWake)}</span>}
      </span>
    </button>
  );
}
