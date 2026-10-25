import { useEffect, useState } from "react";
import { api, type Agent, type ComputerResource } from "../api.ts";
import { errorText, memberNames, PROFILE_NAMES, SHARED_STATE, shareSentence } from "../computerLabels.ts";

function useComputerOptions(agent: Agent) {
  const [resources, setResources] = useState<ComputerResource[]>([]);
  const [usableIds, setUsableIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([api.computers(), api.runtimeCapabilities()]).then(([computers, runtimes]) => {
      if (!live) return;
      setResources(computers);
      setUsableIds(runtimes.runtimes.filter((runtime) => runtime.status === "ready").flatMap((runtime) => computers.filter((computer) => computer.runtime === runtime.runtime && runtime.capabilities.profiles.includes(computer.profile)).map((computer) => computer.id)));
    }).catch((caught: unknown) => {
      if (live) setError(errorText(caught));
    });
    return () => { live = false; };
  }, [agent.computerId]);
  return { resources, setResources, usableIds, error, setError };
}

function PlacementHint({ agent }: { agent: Agent }) {
  if (agent.engine !== "claude-code") return <p className="hint">Virtual computers for Codex are disabled until the restricted tool adapter passes its host isolation probe.</p>;
  if (agent.connectors.length > 0) return <p className="hint">Agents with connectors work only on your Mac. Clear the connectors to use a virtual computer.</p>;
  return null;
}

function sharingNote(resource: ComputerResource, agentId: string): string {
  const others = resource.members.some((member) => member.agentId !== agentId);
  return others ? `Shared with ${memberNames(resource, agentId)}: they see the same ${SHARED_STATE}.` : "No other agent uses this computer.";
}

export function ComputerAccess({ agent, connected }: { agent: Agent; connected: boolean }) {
  const { resources, setResources, usableIds, error, setError } = useComputerOptions(agent);
  const [selectedId, setSelectedId] = useState(agent.computerId ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSelectedId(agent.computerId ?? ""); }, [agent.computerId]);

  const ready = usableIds.length > 0;
  const current = resources.find((resource) => resource.id === agent.computerId);
  const options = resources.filter((resource) => (resource.managed && usableIds.includes(resource.id)) || resource.id === agent.computerId);
  const allowedAgent = agent.engine === "claude-code" && agent.connectors.length === 0;
  const run = async (question: string, action: () => Promise<string>) => {
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      const nextId = await action();
      setResources(await api.computers());
      setSelectedId(nextId);
    } catch (caught) {
      setError(errorText(caught));
    } finally { setBusy(false); }
  };
  const attach = () => {
    const selected = resources.find((resource) => resource.id === selectedId);
    if (!selectedId || !selected) return;
    void run(`Attach ${agent.name} to ${selected.name}? This switches the agent to an isolated virtual computer. ${shareSentence(selected, agent.id)} Chats and task histories stay separate.`,
      async () => (await api.attachComputer(agent.id, selectedId)).computerId ?? selectedId);
  };
  const detach = () => {
    const others = current?.members.some((member) => member.agentId !== agent.id);
    const note = others && current ? ` ${memberNames(current, agent.id)} keep access to the same files.` : " The computer home stays in Hive until you explicitly delete the computer.";
    void run(`Detach ${agent.name} from ${current?.name ?? "this computer"} and switch it to Mac access?${note}`, async () => { await api.detachComputer(agent.id); return ""; });
  };

  return <section className="computer-access" aria-label="Computer assignment">
    <h3>Computer</h3>
    {current ? <p className="muted">Using <strong>{current.name}</strong> · {PROFILE_NAMES[current.profile]}. {sharingNote(current, agent.id)} Chat and task histories stay separate.</p> : <p className="muted">{agent.computer === "virtual" ? "Using the agent's private virtual computer." : "This agent works on your Mac."}</p>}
    <PlacementHint agent={agent} />
    {allowedAgent && <div className="row">
      <select aria-label={`Computer for ${agent.name}`} value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={!connected || busy || !ready}>
        <option value="">Choose a shared computer</option>
        {options.map((resource) => <option key={resource.id} value={resource.id}>{resource.name} · {PROFILE_NAMES[resource.profile]}</option>)}
      </select>
      {agent.computerId ? <>
        <button className="ghost" onClick={attach} disabled={!connected || busy || !ready || !selectedId || selectedId === agent.computerId}>Move</button>
        <button className="ghost" onClick={detach} disabled={!connected || busy}>Detach</button>
      </> : <button className="ghost" onClick={attach} disabled={!connected || busy || !ready || !selectedId}>Attach</button>}
    </div>}
    {!ready && allowedAgent && <p className="hint">A supported runtime and profile must be ready. Check the Computers page for official setup guides.</p>}
    {error && <p className="error">{error}</p>}
  </section>;
}
