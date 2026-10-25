import { useState, type FormEvent } from "react";
import { api, ApiError, type Agent, type AgentBudget } from "../api.ts";
import { agentUnit, limitToText, textToLimit } from "../budgetMath.ts";
import { BudgetBar } from "./Budgets.tsx";
import { Schedules } from "./Schedules.tsx";
import { ComputerAccess } from "./ComputerAccess.tsx";

function DailyBudget({ agent, budget, connected }: { agent: Agent; budget: AgentBudget | undefined; connected: boolean }) {
  const unit = agent.engine === "codex" ? "tokens" : "usd";
  const [text, setText] = useState(() => limitToText(agent.dailyBudget, unit));
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const limit = textToLimit(text, unit);
    if (limit === "invalid") {
      setError(unit === "usd" ? "Use a dollar amount, or leave it empty for no limit." : "Use a whole number of tokens, or leave it empty for no limit.");
      return;
    }
    setError(null);
    try {
      await api.setDailyBudget(agent.id, limit);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't save the budget.");
    }
  };

  return (
    <section className="daily-budget" aria-label="Daily budget">
      <h3>Daily budget</h3>
      {budget && <BudgetBar label="Today" spent={budget.spent} limit={budget.limit} unit={agentUnit(budget.unit)} />}
      <form className="row" onSubmit={submit}>
        <input inputMode="decimal" aria-label={unit === "usd" ? "Daily budget in USD" : "Daily budget in tokens"} value={text} placeholder={unit === "usd" ? "No limit, in USD" : "No limit, in tokens"} onChange={(event) => setText(event.target.value)} />
        <button className="ghost" type="submit" disabled={!connected}>Save</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Rules({ agent, connected }: { agent: Agent; connected: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const remove = async (rule: string) => {
    setError(null);
    try {
      await api.removeRule(agent.id, rule);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't remove the rule.");
    }
  };
  return (
    <section className="rules" aria-label="Always allowed">
      <h3>Always allowed</h3>
      {agent.allowedTools.length === 0 ? (
        <p className="muted">Nothing yet. “Always allow” on an approval adds a rule here.</p>
      ) : (
        <ul className="rule-list">
          {agent.allowedTools.map((rule) => (
            <li key={rule}>
              <code>{rule}</code>
              <button className="ghost danger" disabled={!connected} onClick={() => void remove(rule)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">Removing a Bash rule works at once. Removing a rule for a whole tool, such as Read or Edit, applies from {agent.name}'s next run.</p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

interface Props {
  agent: Agent;
  budget: AgentBudget | undefined;
  connected: boolean;
}

export function AgentSettings({ agent, budget, connected }: Props) {
  return (
    <details className="settings">
      <summary>Schedules, budget, computer and saved rules</summary>
      <div className="settings-body">
        <Schedules agent={agent} connected={connected} />
        <ComputerAccess agent={agent} connected={connected} />
        <DailyBudget key={`${agent.id}-${agent.dailyBudget}`} agent={agent} budget={budget} connected={connected} />
        <Rules agent={agent} connected={connected} />
      </div>
    </details>
  );
}
