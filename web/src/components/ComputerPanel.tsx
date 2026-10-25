import { useEffect, useState } from "react";
import { api, ApiError, type Agent, type ComputerState, type ComputerStatus } from "../api.ts";
import { openScreen, ScreenWindowError } from "../screenWindow.ts";

const LABELS: Record<ComputerState, string> = {
  missing: "Not set up yet",
  building: "Preparing the virtual computer…",
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  error: "Couldn't start",
};

const HINTS: Partial<Record<ComputerState, string>> = {
  missing: "The first start builds it, which takes a few minutes.",
  stopped: "It starts on the next message, or press Start. Files in its home stay.",
};

const STARTABLE: readonly ComputerState[] = ["missing", "stopped", "error"];
const STOPPABLE: readonly ComputerState[] = ["starting", "running"];

export function ComputerPanel({ agent, status }: { agent: Agent; status: ComputerStatus }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenAvailable, setScreenAvailable] = useState(agent.computerId === null);
  const [computerName, setComputerName] = useState<string | null>(null);

  useEffect(() => {
    if (!agent.computerId) { setScreenAvailable(true); setComputerName(null); return; }
    let live = true;
    Promise.all([api.computers(), api.runtimeCapabilities()]).then(([computers, capabilities]) => {
      const resource = computers.find((item) => item.id === agent.computerId);
      const profile = capabilities.profiles.find((item) => item.id === resource?.profile);
      if (!live) return;
      setScreenAvailable(profile?.hasScreen ?? false);
      setComputerName(resource?.name ?? null);
    }).catch(() => { if (live) setScreenAvailable(false); });
    return () => { live = false; };
  }, [agent.computerId]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof ScreenWindowError ? caught.message : "Hive didn't answer.");
    } finally {
      setBusy(false);
    }
  };

  const detail = status.detail ?? HINTS[status.state];
  return (
    <section className={`computer ${status.state}`} aria-label="Virtual computer">
      <span className="computer-dot" />
      <div className="computer-text">
        <strong>{computerName ?? "Virtual computer"} · {LABELS[status.state]}</strong>
        {detail && <span className="muted">{detail}</span>}
        {error && <span className="error">{error}</span>}
      </div>
      <div className="actions">
        {STARTABLE.includes(status.state) && <button className="ghost" disabled={busy} onClick={() => void act(() => api.startComputer(agent.id))}>Start</button>}
        {STOPPABLE.includes(status.state) && <button className="ghost" disabled={busy} onClick={() => void act(() => api.stopComputer(agent.id))}>Stop</button>}
        {screenAvailable && <button className="primary" disabled={busy || status.state !== "running"} onClick={() => void act(() => openScreen(agent.id))}>Open screen</button>}
      </div>
    </section>
  );
}
