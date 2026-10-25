import { useState } from "react";
import { api, ApiError, type HubState } from "../api.ts";
import { formatWake } from "../wake.ts";

export function PauseBanner({ state, connected }: { state: HubState; connected: boolean }) {
  const [error, setError] = useState<string | null>(null);
  if (!state.paused) return null;
  const resume = async () => {
    setError(null);
    try {
      await api.resume();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't resume.");
    }
  };
  return (
    <section className="pause-banner" role="status" aria-label="Hive is paused">
      <div className="pause-text">
        <strong>Hive is paused{state.pausedAt ? ` since ${formatWake(state.pausedAt)}` : ""}</strong>
        <span className="muted">Every run was stopped and nothing starts, schedules included, until you resume.</span>
        {error && <span className="error">{error}</span>}
      </div>
      <button className="primary" disabled={!connected} onClick={() => void resume()}>Resume</button>
    </section>
  );
}

export function PauseButton({ paused, connected, hasAgents }: { paused: boolean; connected: boolean; hasAgents: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (paused) return null;
  const pause = async () => {
    if (!window.confirm("Pause everything? This stops every run, denies pending approvals and stops virtual computers.")) return;
    setBusy(true);
    setError(null);
    try {
      await api.pause();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't pause.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error && <span className="error">{error}</span>}
      <button className="ghost danger new" disabled={!connected || busy || !hasAgents} title={hasAgents ? undefined : "Nothing to pause yet: you have no agents."} onClick={() => void pause()}>Pause everything</button>
    </>
  );
}
