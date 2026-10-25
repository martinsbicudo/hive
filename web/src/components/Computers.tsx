import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type Agent, type ComputerResource, type RuntimeCapabilities } from "../api.ts";
import { errorText, PROFILE_NAMES, SHARED_STATE } from "../computerLabels.ts";
import { useEngineSetup } from "../engineSetup.ts";
import { computerProfile } from "../runtimeCapabilities.ts";
import { EngineSetup } from "./EngineSetup.tsx";
import { ResourceCard } from "./ResourceCard.tsx";

type Act = (action: () => Promise<unknown>) => Promise<void>;
type ProfileId = "terminal" | "browser" | "desktop";

export function Computers({ agents, connected }: { agents: Agent[]; connected: boolean }) {
  const [resources, setResources] = useState<ComputerResource[]>([]);
  const [runtime, setRuntime] = useState<RuntimeCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setup = useEngineSetup(() => void refresh());
  const loadSetup = setup.load;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [nextResources, nextRuntime] = await Promise.allSettled([api.computers(), api.runtimeCapabilities(), loadSetup()]);
    if (nextResources.status === "fulfilled") setResources(nextResources.value);
    if (nextRuntime.status === "fulfilled") setRuntime(nextRuntime.value);
    const failed = nextResources.status === "rejected" ? nextResources.reason : nextRuntime.status === "rejected" ? nextRuntime.reason : null;
    if (failed) setError(errorText(failed));
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const act: Act = async (action) => {
    setBusy(true);
    setError(null);
    try { await action(); await refresh(); }
    catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  };

  const eligibleAgents = agents.filter((agent) => agent.engine === "claude-code" && agent.connectors.length === 0);
  const supported = (runtimeId: string) => runtime?.runtimes.find((item) => item.runtime === runtimeId)?.capabilities.profiles ?? [];
  const activeEngine = setup.status?.providers.find((provider) => provider.active && provider.running) ?? null;

  return (
    <section className="computers-page">
      <header className="page-head"><div><h2>Computers</h2><p className="muted">Shared isolated workspaces for virtual agents.</p></div><button className="ghost" onClick={() => void refresh()} disabled={loading}>Check again</button></header>
      {error && <p className="error" role="alert">{error}</p>}
      <EngineSetup runtime={runtime} status={setup.status} loading={loading} disabled={!connected} onStatus={setup.setStatus} />
      <CreateComputer runtime={runtime} disabled={!connected || busy} act={act} />
      <section className="resource-section">
        <div className="section-title"><h3>Your computers</h3><span className="count">{resources.length}</span></div>
        {resources.length === 0 && <p className="muted">No computers yet.</p>}
        <div className="resource-list">{resources.map((resource) => <ResourceCard key={resource.id} resource={resource} agents={eligibleAgents} profiles={runtime?.profiles ?? []} supportedProfiles={supported(resource.runtime)} activeEngine={activeEngine} busy={busy || !connected} onChange={(action) => void act(action)} />)}</div>
      </section>
    </section>
  );
}

function CreateComputer({ runtime, disabled, act }: { runtime: RuntimeCapabilities | null; disabled: boolean; act: Act }) {
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<ProfileId>("desktop");
  const availableRuntime = runtime?.runtimes.find((item) => item.runtime === "docker");
  const profiles = useMemo(() => availableRuntime?.capabilities.profiles ?? [], [availableRuntime]);

  useEffect(() => {
    const first = profiles[0];
    if (!profiles.includes(profile) && first) setProfile(first);
  }, [profile, profiles]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    await act(async () => {
      await api.createComputer({ name: name.trim() || "Shared computer", runtime: "docker", profile });
      setName("");
    });
  };

  return <section className="resource-section">
    <h3>Create a computer</h3>
    <p className="muted">Creating a computer sets up its isolated storage. Hive installs or starts an engine only when you ask, from Engine above.</p>
    <form className="computer-create" onSubmit={(event) => void create(event)}>
      <label>Name<input value={name} maxLength={50} placeholder="e.g. Research workspace" onChange={(event) => setName(event.target.value)} /></label>
      <label>Profile<select value={profile} onChange={(event) => { const parsed = computerProfile.safeParse(event.target.value); if (parsed.success) setProfile(parsed.data); }} disabled={!profiles.length}>
        {profiles.map((id) => <option key={id} value={id}>{PROFILE_NAMES[id]}</option>)}
      </select></label>
      <button className="primary" type="submit" disabled={disabled || availableRuntime?.status !== "ready" || !profiles.includes(profile)}>Create computer</button>
    </form>
    {availableRuntime?.status !== "ready" && <p className="hint">Set up or start an engine above before creating a computer.</p>}
    <p className="shared-disclosure">Agents attached to one computer share its {SHARED_STATE}. Hive runs one of them at a time. Their chat and task histories remain separate.</p>
  </section>;
}
