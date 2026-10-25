import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, ENGINE_NAMES, previewAvatarUrl, type Agent, type AgentForm as Form, type AgentTemplate, type ArchitectProposal, type HubOptions } from "../api.ts";
import { createWithSchedules, formFromProposal, formFromTemplate } from "../proposal.ts";
import { ConnectorsField } from "./ConnectorsField.tsx";
import { ProposalNotes } from "./ProposalNotes.tsx";
import { RolePicker } from "./RolePicker.tsx";

const PLACES = [
  { computer: "mac", title: "Your Mac", note: "Asks before acting." },
  { computer: "virtual", title: "Virtual computer", note: "Isolated from your Mac. It has the web, but not your accounts or your local network." },
] as const;

const MODEL_LABELS: Record<string, string> = {
  auto: "Auto: picks the model per task",
  haiku: "Haiku: fast and cheap",
  sonnet: "Sonnet: balanced",
  opus: "Opus: deepest reasoning",
};

function initialForm(agent: Agent | null): Form {
  return {
    name: agent?.name ?? "",
    role: agent?.role ?? "",
    engine: agent?.engine ?? "claude-code",
    model: agent?.model ?? "auto",
    instructions: agent?.instructions ?? "",
    avatarStyle: agent?.avatarStyle ?? "notionists",
    useMySetup: agent?.useMySetup ?? true,
    permissionMode: agent?.permissionMode ?? "ask",
    folders: agent?.folders ?? [],
    computer: agent?.computer ?? "mac",
    connectors: agent?.connectors ?? [],
  };
}

interface Props {
  agent: Agent | null;
  proposal?: ArchitectProposal;
  template?: AgentTemplate;
  tabs?: ReactNode;
  options: HubOptions;
  onClose: () => void;
  onBack?: () => void;
  onSaved: (agent: Agent) => void;
}

export function AgentFormDialog({ agent, proposal, template, tabs, options, onClose, onBack, onSaved }: Props) {
  const [form, setForm] = useState<Form>(() => (proposal ? formFromProposal(proposal) : template ? formFromTemplate(template) : initialForm(agent)));
  const [schedules, setSchedules] = useState(proposal?.schedules ?? template?.schedules ?? []);
  const prefilled = proposal !== undefined || template !== undefined;
  const [created, setCreated] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [runtimeCheck, setRuntimeCheck] = useState<Awaited<ReturnType<typeof api.runtimeCapabilities>> | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [previewSeed, setPreviewSeed] = useState(() => agent?.avatarSeed ?? template?.avatar.seed ?? `preview-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const checkRuntime = async () => {
    setRuntimeError(null);
    try { setRuntimeCheck(await api.runtimeCapabilities()); }
    catch (caught) { setRuntimeError(caught instanceof ApiError ? caught.message : "Runtime check failed."); }
  };

  useEffect(() => { void checkRuntime(); }, []);

  const update = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const withConnectors = form.connectors.length > 0;
  const models = options.models[form.engine];
  const readyComputer = runtimeCheck?.runtimes.some((item) => item.status === "ready" && item.capabilities.profiles.length > 0) ?? false;
  const virtualUnavailable = form.engine === "codex" || !readyComputer;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (created) {
      onSaved(created);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (prefilled) {
        const result = await createWithSchedules(form, previewSeed, schedules);
        if (result.failures.length === 0) {
          onSaved(result.agent);
          return;
        }
        setCreated(result.agent);
        setError(`${result.agent.name} was created, but these schedules failed: ${result.failures.join("; ")}. You can add them again from its settings.`);
        return;
      }
      const saved = agent ? await api.updateAgent(agent.id, form) : await api.createAgent(form, previewSeed);
      onSaved(saved);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't save the agent.");
    } finally {
      setSaving(false);
    }
  };

  const pickName = () => {
    const free = options.names.filter((name) => name !== form.name);
    update("name", free[Math.floor(Math.random() * free.length)] ?? "");
  };

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit} aria-label={agent ? "Edit agent" : "New agent"}>
        <header className="dialog-head">
          <img className="avatar xl" src={agent && form.avatarStyle === agent.avatarStyle ? previewAvatarUrl(form.avatarStyle, agent.avatarSeed) : previewAvatarUrl(form.avatarStyle, previewSeed)} alt="" />
          <div>
            <h2>{agent ? `Edit ${agent.name}` : proposal ? "Review the Architect's proposal" : template ? `New ${template.name}` : "New agent"}</h2>
            <p className="muted">{form.name || "Hive picks a name"} · {form.role || "Personal Assistant"}</p>
          </div>
        </header>

        {tabs}
        {prefilled && <p className="muted">Nothing exists yet. Change anything you like, then click Create agent.</p>}

        <div className="grid two">
          <label>
            Name
            <div className="row">
              <input value={form.name} maxLength={40} placeholder="Leave empty and Hive picks one" onChange={(event) => update("name", event.target.value)} />
              <button type="button" className="ghost icon" title="Suggest a name" aria-label="Suggest a name" onClick={pickName}>🎲</button>
            </div>
          </label>
          <label>
            Role
            <div className="row">
              <input aria-label="Role" value={form.role} maxLength={60} placeholder="Software Engineer" onChange={(event) => update("role", event.target.value)} />
              <RolePicker roles={options.roles} onPick={(role) => update("role", role)} />
            </div>
          </label>
        </div>

        <fieldset>
          <legend>Avatar</legend>
          <div className="styles">
            {options.avatarStyles.map((style) => (
              <button type="button" key={style} className={`style ${form.avatarStyle === style ? "selected" : ""}`} onClick={() => update("avatarStyle", style)} title={style}>
                <img src={previewAvatarUrl(style, agent?.avatarSeed ?? previewSeed)} alt={style} />
              </button>
            ))}
            {!agent && <button type="button" className="ghost" onClick={() => setPreviewSeed(`preview-${Math.random().toString(36).slice(2, 8)}`)}>Shuffle</button>}
          </div>
        </fieldset>

        <div className="grid two">
          <fieldset>
            <legend>Engine</legend>
            <div className="segmented">
              {(["claude-code", "codex"] as const).map((engine) => (
                <button type="button" key={engine} className={form.engine === engine ? "on" : ""} onClick={() => setForm((current) => ({ ...current, engine, model: "auto", computer: engine === "codex" ? "mac" : current.computer, connectors: engine === "codex" ? [] : current.connectors }))}>
                  {ENGINE_NAMES[engine]}
                </button>
              ))}
            </div>
          </fieldset>
          <label>
            Model
            <select value={form.model} onChange={(event) => update("model", event.target.value)}>
              {models.map((model) => <option key={model} value={model}>{MODEL_LABELS[model] ?? model}</option>)}
            </select>
            {form.engine === "codex" && <span className="hint">Codex uses your Codex default model.</span>}
          </label>
        </div>

        <label>
          {proposal ? "Instructions (written by the Architect)" : template ? "Instructions (from the template)" : "Instructions"}
          <textarea rows={prefilled ? 10 : 4} maxLength={8000} value={form.instructions} placeholder="What should this agent focus on? Tone, rules, tools to prefer…" onChange={(event) => update("instructions", event.target.value)} />
        </label>

        <fieldset>
          <legend>Where it works</legend>
          <div className="places" role="radiogroup" aria-label="Where it works">
            {PLACES.map((place) => {
              const blocked = place.computer === "virtual" && virtualUnavailable;
              return (
                <button type="button" role="radio" aria-checked={form.computer === place.computer} key={place.computer} disabled={blocked}
                  className={`place ${form.computer === place.computer ? "on" : ""}`} onClick={() => setForm((current) => ({ ...current, computer: place.computer, connectors: place.computer === "virtual" ? [] : current.connectors }))}>
                  <strong>{place.title}</strong>
                  <span>{place.note}</span>
                </button>
              );
            })}
          </div>
          {virtualUnavailable && (
            <div className="runtime-form-note">
              <span className="hint">{form.engine === "codex" ? "Codex virtual computers stay disabled until their restricted tool adapter passes the isolation probe." : runtimeError ?? runtimeCheck?.runtimes.find((item) => item.status !== "ready")?.detail ?? "A supported runtime and profile must be ready before virtual agents can be selected."}</span>
              {form.engine !== "codex" && <button type="button" className="ghost" onClick={() => void checkRuntime()}>Check again</button>}
              {runtimeCheck?.guides.filter((guide) => guide.maturity === "supported").map((guide) => <a key={guide.runtime} href={guide.setupUrl} target="_blank" rel="noreferrer">{guide.provider} setup guide</a>)}
            </div>
          )}
          {agent && agent.computer !== form.computer && <span className="hint">Switching starts a fresh session.</span>}
          {agent && agent.connectors.length > 0 && form.connectors.length === 0 && (form.computer === "virtual" || form.engine === "codex") && (
            <span className="hint">Connectors work only on your Mac with Claude Code, so this clears them.</span>
          )}
        </fieldset>

        {form.computer === "mac" && form.engine === "claude-code" && <ConnectorsField connectors={form.connectors} onChange={(connectors) => update("connectors", connectors)} />}

        {form.computer === "mac" && (
          <>
            <div className="grid two">
              {form.engine === "claude-code" ? (
                <label>
                  Before acting on your Mac
                  <select value={form.permissionMode} onChange={(event) => update("permissionMode", event.target.value === "accept-edits" ? "accept-edits" : "ask")}>
                    <option value="ask">Ask me before every action</option>
                    <option value="accept-edits">Allow file edits, ask for the rest</option>
                  </select>
                </label>
              ) : (
                <div className="stacked">
                  <span>Before acting on your Mac</span>
                  <span className="hint">Codex doesn't ask before acting. It runs in its own sandbox: it writes only to the agent's folders and can't control your Mac apps.</span>
                </div>
              )}
              <div className="field">
                <span className="field-label">Use my {ENGINE_NAMES[form.engine]} setup</span>
                <label className={`toggle-box ${form.useMySetup && !withConnectors ? "on" : ""}`}>
                  <span>Skills, plugins, MCP servers</span>
                  <input type="checkbox" role="switch" className="switch" aria-label={`Use my ${ENGINE_NAMES[form.engine]} setup`} checked={form.useMySetup && !withConnectors} disabled={withConnectors} onChange={(event) => update("useMySetup", event.target.checked)} />
                </label>
                {withConnectors && <span className="hint">Off while connectors are on, so none of your own settings or allow rules can loosen the agent's external-content posture.</span>}
              </div>
            </div>

            <label>
              Folders it can work in (one absolute path per line)
              <textarea rows={2} value={form.folders.join("\n")} placeholder="/Users/me/Projects/my-app" onChange={(event) => update("folders", event.target.value.split("\n").map((line) => line.trim()).filter(Boolean))} />
            </label>
          </>
        )}
        {form.computer === "virtual" && <p className="hint">On its virtual computer the agent uses only Hive's computer tools and web search, so folders, permissions and your setup don't apply.</p>}

        {prefilled && <ProposalNotes origin={template ? "template" : "architect"} notes={template?.notes ?? []} folders={form.computer === "mac" ? form.folders : []} useMySetup={form.useMySetup} connectors={form.connectors} schedules={schedules} onRemoveSchedule={(index) => setSchedules((current) => current.filter((_, at) => at !== index))} />}

        {error && <p className="error">{error}</p>}
        <footer className="dialog-foot">
          <button type="button" className="ghost" onClick={created || !onBack ? onClose : onBack}>{created ? "Close" : "Cancel"}</button>
          <button type="submit" className="primary" disabled={saving}>{saving ? "Saving…" : created ? `Open ${created.name}` : agent ? "Save" : "Create agent"}</button>
        </footer>
      </form>
    </div>
  );
}
