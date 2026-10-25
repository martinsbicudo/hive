import { useState } from "react";
import { api, type Agent, type ComputerResource, type RuntimeCapabilities } from "../api.ts";
import { ENGINE_NAMES, memberNames, PROFILE_NAMES, SHARED_STATE, shareSentence } from "../computerLabels.ts";
import type { ProviderInfo } from "../engineSetup.ts";
import { computerProfile } from "../runtimeCapabilities.ts";

type Profiles = RuntimeCapabilities["profiles"];
type Change = (action: () => Promise<unknown>) => void;

interface Props {
  resource: ComputerResource;
  agents: Agent[];
  profiles: Profiles;
  supportedProfiles: RuntimeCapabilities["runtimes"][number]["capabilities"]["profiles"];
  activeEngine: ProviderInfo | null;
  busy: boolean;
  onChange: Change;
}

function profileChangeMessage(from: Profiles[number] | undefined, to: Profiles[number] | undefined, fallback: string): string {
  const removed: string[] = [];
  if (from?.browser && !to?.browser) removed.push("browser profile data, including cookies and local storage");
  if (from?.fullDesktop && !to?.fullDesktop) removed.push("desktop processes and live screen state");
  return removed.length > 0
    ? `Change from ${from?.name} to ${to?.name}? This removes ${removed.join(" and ")}. The computer home and agent chat/task histories remain.`
    : `Change from ${from?.name ?? fallback} to ${to?.name ?? fallback}? The computer home, retained browser data, and agent chat/task histories remain.`;
}

export function ResourceCard({ resource, agents, profiles, supportedProfiles, activeEngine, busy, onChange }: Props) {
  const profileInfo = profiles.find((item) => item.id === resource.profile);
  const [newName, setNewName] = useState(resource.name);
  const updateProfile = (value: string) => {
    const parsed = computerProfile.safeParse(value);
    if (!parsed.success || !supportedProfiles.includes(parsed.data)) return;
    const message = profileChangeMessage(profileInfo, profiles.find((item) => item.id === parsed.data), parsed.data);
    if (window.confirm(message)) onChange(() => api.updateComputer(resource.id, { profile: parsed.data }));
  };
  const deleteResource = () => {
    if (window.confirm(`Delete ${resource.name}? Its computer home and files will be removed. This cannot be undone.`)) onChange(() => api.deleteComputer(resource.id));
  };
  const shareResource = () => {
    if (!window.confirm(`Share ${resource.name} with virtual agents? This promotes the existing computer home; it does not create a new disk. Attached agents share its ${SHARED_STATE}. Their chats and task histories stay separate.`)) return;
    onChange(() => api.updateComputer(resource.id, { managed: true }));
  };
  const rename = () => {
    if (newName.trim() && newName !== resource.name) onChange(() => api.updateComputer(resource.id, { name: newName.trim() }));
  };

  return <article className="resource-card">
    <div className="resource-head"><div><h4>{resource.name}</h4><p className="muted">{resource.engine ? ENGINE_NAMES[resource.engine] : "Engine chosen at first start"} · {PROFILE_NAMES[resource.profile]} · Revision {resource.revision}</p></div><span className="pill">{resource.members.length} {resource.members.length === 1 ? "agent" : "agents"}</span></div>
    <div className="resource-config">
      <form className="row" onSubmit={(event) => { event.preventDefault(); rename(); }}>
        <input aria-label={`Name for ${resource.name}`} value={newName} maxLength={50} onChange={(event) => setNewName(event.target.value)} />
        <button className="ghost" disabled={busy || newName.trim() === resource.name}>Rename</button>
      </form>
      <label>Profile<select value={resource.profile} disabled={busy} onChange={(event) => updateProfile(event.target.value)}>
        {profiles.filter((item) => supportedProfiles.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
    </div>
    {profileInfo && <p className="hint">{profileInfo.description}{profileInfo.hasScreen ? " Screen and input available." : " No live screen."}</p>}
    <p className="muted">Profile changes keep this computer home and agent chat/task history. Browser data persists when the new profile includes the browser.</p>
    <Members resource={resource} agents={agents} busy={busy} onChange={onChange} />
    <EngineMove resource={resource} activeEngine={activeEngine} busy={busy} onChange={onChange} />
    <div className="resource-footer">
      <span className="hint">{resource.engine ? `Its files live in ${ENGINE_NAMES[resource.engine]}.` : "Its files go to the engine in use when it first starts."}</span>
      {!resource.managed && <button className="ghost" disabled={busy} onClick={shareResource}>Share this computer</button>}
      {resource.managed && <button className="ghost danger" disabled={busy || resource.members.length > 0} onClick={deleteResource}>Delete computer</button>}
    </div>
  </article>;
}

function Members({ resource, agents, busy, onChange }: Pick<Props, "resource" | "agents" | "busy" | "onChange">) {
  const memberIds = new Set(resource.members.map((member) => member.agentId));
  const available = agents.filter((agent) => !memberIds.has(agent.id));
  const [attachId, setAttachId] = useState("");
  const attachAgent = () => {
    const agent = agents.find((item) => item.id === attachId);
    if (!agent) return;
    const message = `Attach ${agent.name} to ${resource.name}? This switches the agent to a virtual computer. ${shareSentence(resource, agent.id)} Chats and task histories remain separate.`;
    if (window.confirm(message)) onChange(() => api.attachComputer(agent.id, resource.id));
  };
  const detachMember = (member: ComputerResource["members"][number]) => {
    const others = resource.members.length > 1 ? ` ${memberNames(resource, member.agentId)} keep access to the same files.` : " The computer home stays until you delete the computer.";
    if (window.confirm(`Detach ${member.name} from ${resource.name} and switch it to Mac access?${others}`)) onChange(() => api.detachComputer(member.agentId));
  };
  return <div className="members"><strong>Members</strong>
    {resource.members.length === 0 && <span className="muted">{resource.managed ? "No agents attached. This computer stays until you delete it." : "No agents attached. This is an agent's earlier computer; it is removed when that agent is deleted."}</span>}
    {resource.members.length > 1 && <span className="hint">These agents share the {SHARED_STATE}. Hive runs one of them at a time.</span>}
    {resource.members.map((member) => <div className="member-row" key={member.agentId}><span>{member.name}</span><button className="ghost" disabled={busy} onClick={() => detachMember(member)}>Detach</button></div>)}
    {available.length > 0 && resource.managed && <div className="row attach-row"><select aria-label={`Agent to attach to ${resource.name}`} value={attachId} onChange={(event) => setAttachId(event.target.value)}><option value="">Choose an agent</option>{available.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><button className="ghost" disabled={busy || !attachId} onClick={attachAgent}>Attach agent</button></div>}
    {!resource.managed && <span className="hint">Share this existing computer before attaching another agent. Sharing keeps the same home disk.</span>}
  </div>;
}

function EngineMove({ resource, activeEngine, busy, onChange }: Pick<Props, "resource" | "activeEngine" | "busy" | "onChange">) {
  if (!resource.engine || !activeEngine || resource.engine === activeEngine.id) return null;
  const old = ENGINE_NAMES[resource.engine];
  const move = () => {
    const message = `Move ${resource.name} to ${activeEngine.name}? It starts there with an empty home. Its current home stays untouched in ${old}; moving it back to ${old} later brings that home back.`;
    if (window.confirm(message)) onChange(() => api.moveComputerEngine(resource.id));
  };
  return <div className="engine-move" role="status">
    <span>This computer's files are in {old}, but {activeEngine.name} is the engine in use, so it won't start. Switch back to {old}, or move it.</span>
    <button className="ghost" disabled={busy} onClick={move}>Move to {activeEngine.name}</button>
  </div>;
}
