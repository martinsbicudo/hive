import { useState } from "react";
import type { RuntimeCapabilities } from "../api.ts";
import { errorText, STATUS_NAMES } from "../computerLabels.ts";
import { PROVIDER_FACTS, setupApi, setupSteps, STEP_NAMES, type ProviderInfo, type SetupStatus } from "../engineSetup.ts";

interface Props {
  runtime: RuntimeCapabilities | null;
  status: SetupStatus | null;
  loading: boolean;
  disabled: boolean;
  onStatus: (status: SetupStatus) => void;
}

function providerState(provider: ProviderInfo): string {
  if (provider.active && provider.running) return "In use";
  if (provider.running) return "Running";
  return provider.installed ? "Installed, not running" : "Not installed";
}

// A finished setup's "ready" card would be stale once that engine is quit again.
function showProgress(status: SetupStatus): boolean {
  if (status.state === "idle") return false;
  return status.state !== "done" || status.providers.some((provider) => provider.id === status.provider && provider.running);
}

export function EngineSetup({ runtime, status, loading, disabled, onStatus }: Props) {
  const [confirming, setConfirming] = useState<ProviderInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = runtime?.runtimes[0];
  const running = status?.state === "running";

  const call = async (work: () => Promise<SetupStatus>) => {
    setError(null);
    try { onStatus(await work()); } catch (caught) { setError(errorText(caught)); }
  };
  const begin = (provider: ProviderInfo) => {
    setConfirming(null);
    void call(() => setupApi.start(provider.id));
  };

  return <section className="runtime-check" aria-label="Engine">
    <div className="runtime-heading"><h3>Engine</h3>{loading && <span className="muted">Checking…</span>}</div>
    {active && <article className={`runtime-card ${active.status}`}>
      <div><strong>{active.provider} · {STATUS_NAMES[active.status]}</strong><p className="muted">{active.detail}</p></div>
    </article>}
    {status && showProgress(status) && <SetupProgress status={status} onCancel={() => void call(setupApi.cancel)} onRetry={(provider) => void call(() => setupApi.start(provider))} />}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="engine-cards">
      {status?.providers.map((provider) => <article className="engine-card" key={provider.id}>
        <div className="engine-card-head"><strong>{provider.name}</strong>{provider.recommended && <span className="pill">Recommended</span>}</div>
        <p className="muted">{providerState(provider)} · by {PROVIDER_FACTS[provider.id].vendor}</p>
        {!provider.running && <button className="ghost" disabled={disabled || running} onClick={() => setConfirming(provider)}>{provider.installed ? `Start ${provider.name}` : `Set up ${provider.name}`}</button>}
      </article>)}
    </div>
    {!status && !loading && <p className="muted">Engine checks are unavailable. Try again when Hive reconnects.</p>}
    {confirming && <ConfirmSetup provider={confirming} onCancel={() => setConfirming(null)} onConfirm={() => begin(confirming)} />}
  </section>;
}

function SetupProgress({ status, onCancel, onRetry }: { status: SetupStatus; onCancel: () => void; onRetry: (provider: NonNullable<SetupStatus["provider"]>) => void }) {
  const name = status.providers.find((provider) => provider.id === status.provider)?.name ?? "the engine";
  const percent = Math.round(status.progress * 100);
  const title = status.state === "running" ? `${status.step ? STEP_NAMES[status.step] : "Working"} · ${name}`
    : status.state === "done" ? `${name} is ready` : status.state === "cancelled" ? "Setup cancelled" : "Setup stopped";
  return <article className={`setup-progress ${status.state}`}>
    <div className="engine-card-head"><strong>{title}</strong>{status.state === "running" && <span className="muted">{percent}%</span>}</div>
    {status.state === "running" && <div className="progress-track" role="progressbar" aria-label={`Setting up ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="progress-fill" style={{ width: `${percent}%` }} /></div>}
    <p className="muted" aria-live="polite">{status.detail}</p>
    <div className="actions">
      {status.state === "running" && <button className="ghost" disabled={!status.cancellable} onClick={onCancel}>Cancel</button>}
      {(status.state === "failed" || status.state === "cancelled") && status.provider && <button className="ghost" onClick={() => status.provider && onRetry(status.provider)}>Try again</button>}
    </div>
  </article>;
}

function ConfirmSetup({ provider, onCancel, onConfirm }: { provider: ProviderInfo; onCancel: () => void; onConfirm: () => void }) {
  const verb = provider.installed ? "Start" : "Set up";
  return <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
    <div className="dialog" role="dialog" aria-modal="true" aria-label={`${verb} ${provider.name}`}>
      <h3>{verb} {provider.name}?</h3>
      <p className="muted">Hive will do these steps on this Mac, without your password and without changing your shell or Docker settings:</p>
      <ol className="setup-steps">{setupSteps(provider).map((step) => <li key={step}>{step}</li>)}</ol>
      <p className="shared-disclosure">{PROVIDER_FACTS[provider.id].firstRun} Those windows and choices are yours; Hive never answers them.</p>
      <p className="hint">{provider.installed ? `You can cancel while Hive waits; ${provider.name} keeps opening on its own.` : "You can cancel until the copy into /Applications starts. Hive leaves nothing else behind."}</p>
      <div className="dialog-foot"><button className="ghost" onClick={onCancel}>Not now</button><button className="primary" autoFocus onClick={onConfirm}>{verb} {provider.name}</button></div>
    </div>
  </div>;
}
