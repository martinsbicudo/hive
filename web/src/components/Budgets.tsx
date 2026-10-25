import { useState, type FormEvent } from "react";
import { api, ApiError, formatTokens, formatUsd, type BudgetLimits, type HubState } from "../api.ts";
import { agentUnit, limitToText, ratio, textToLimit, type LimitUnit } from "../budgetMath.ts";

const WARN_AT = 0.8;

function amount(value: number, unit: LimitUnit): string {
  return unit === "usd" ? formatUsd(value / 100) : formatTokens(value);
}

interface BarProps {
  label: string;
  spent: number;
  limit: number | null;
  unit: LimitUnit;
}

export function BudgetBar({ label, spent, limit, unit }: BarProps) {
  const share = ratio(spent, limit);
  const tone = share === null ? "none" : share >= 1 ? "over" : share >= WARN_AT ? "near" : "ok";
  const percent = Math.round((share ?? 0) * 100);
  return (
    <div className={`budget ${tone}`}>
      <div className="budget-head">
        <span>{label}</span>
        <span className="muted">{limit === null ? `${amount(spent, unit)} · no limit` : `${amount(spent, unit)} of ${amount(limit, unit)}`}{unit === "tokens" && " tokens"}</span>
      </div>
      <div className="bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

const FIELDS = [
  { key: "globalDailyUsdCents", label: "Daily limit (USD)", unit: "usd", placeholder: "No limit" },
  { key: "globalDailyTokens", label: "Daily limit (tokens)", unit: "tokens", placeholder: "No limit" },
  { key: "globalMonthlyUsdCents", label: "Monthly limit (USD)", unit: "usd", placeholder: "No limit" },
] as const;

function LimitsForm({ limits, disabled }: { limits: BudgetLimits; disabled: boolean }) {
  const [text, setText] = useState(() => FIELDS.map((field) => limitToText(limits[field.key], field.unit)));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const daily = textToLimit(text[0] ?? "", "usd");
    const tokens = textToLimit(text[1] ?? "", "tokens");
    const monthly = textToLimit(text[2] ?? "", "usd");
    if (daily === "invalid" || tokens === "invalid" || monthly === "invalid") {
      setError("Use whole numbers, or leave a field empty for no limit.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.setBudgets({ globalDailyUsdCents: daily, globalDailyTokens: tokens, globalMonthlyUsdCents: monthly });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't save the limits.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="limits" onSubmit={submit}>
      {FIELDS.map((field, index) => (
        <label key={field.key}>
          {field.label}
          <input inputMode="decimal" value={text[index] ?? ""} placeholder={field.placeholder} onChange={(event) => setText((current) => current.map((value, at) => (at === index ? event.target.value : value)))} />
        </label>
      ))}
      <button className="primary" type="submit" disabled={saving || disabled}>{saving ? "Saving…" : "Save limits"}</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

export function BudgetsPanel({ state, connected }: { state: HubState; connected: boolean }) {
  const { limits, spent, agents } = state.budgets;
  const names = new Map(state.agents.map((agent) => [agent.id, agent.name]));
  return (
    <section className="budgets" aria-label="Budgets">
      <h2>Budgets</h2>
      <p className="muted">A run that would start past a limit is blocked and says so in the chat. Runs already going aren't cut off, so spending can overshoot a little. Days and months follow your local time.</p>
      <div className="cards">
        <article className="card">
          <h3>Everyone</h3>
          <BudgetBar label="Today (USD)" spent={spent.todayUsd * 100} limit={limits.globalDailyUsdCents} unit="usd" />
          <BudgetBar label="Today (tokens)" spent={spent.todayTokens} limit={limits.globalDailyTokens} unit="tokens" />
          <BudgetBar label="This month (USD)" spent={spent.monthUsd * 100} limit={limits.globalMonthlyUsdCents} unit="usd" />
          <LimitsForm key={JSON.stringify(limits)} limits={limits} disabled={!connected} />
        </article>
        <article className="card">
          <h3>Per agent, today</h3>
          <p className="muted">Set an agent's limit in its settings. Claude Code agents count USD, Codex agents count tokens.</p>
          {agents.map((budget) => (
            <BudgetBar key={budget.agentId} label={names.get(budget.agentId) ?? "Agent"} spent={budget.spent} limit={budget.limit} unit={agentUnit(budget.unit)} />
          ))}
          {agents.length === 0 && <p className="muted">No agents yet.</p>}
        </article>
      </div>
    </section>
  );
}
