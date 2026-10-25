import { useEffect, useState } from "react";
import type { Agent, AgentTemplate, ArchitectMessage, ArchitectProposal, HubOptions } from "../api.ts";
import { ArchitectChat } from "./ArchitectChat.tsx";
import { AgentFormDialog } from "./AgentForm.tsx";
import { TemplatePicker } from "./TemplatePicker.tsx";

type Tab = "describe" | "template" | "fill";

interface Props {
  options: HubOptions;
  onClose: () => void;
  onSaved: (agent: Agent) => void;
}

export function NewAgentDialog({ options, onClose, onSaved }: Props) {
  const hasArchitect = options.engines["claude-code"];
  const [tab, setTab] = useState<Tab>(hasArchitect ? "describe" : "fill");
  const [proposal, setProposal] = useState<ArchitectProposal | null>(null);
  const [transcript, setTranscript] = useState<ArchitectMessage[]>([]);
  const [template, setTemplate] = useState<AgentTemplate | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (proposal) return <AgentFormDialog agent={null} proposal={proposal} options={options} onClose={onClose} onBack={() => setProposal(null)} onSaved={onSaved} />;

  if (template) return <AgentFormDialog agent={null} template={template} options={options} onClose={onClose} onBack={() => setTemplate(null)} onSaved={onSaved} />;

  const tabs = (
    <div className="segmented tabs" role="tablist" aria-label="How to create the agent">
      <button type="button" role="tab" aria-selected={tab === "describe"} className={tab === "describe" ? "on" : ""} onClick={() => setTab("describe")}>Describe it</button>
      <button type="button" role="tab" aria-selected={tab === "template"} className={tab === "template" ? "on" : ""} onClick={() => setTab("template")}>From a template</button>
      <button type="button" role="tab" aria-selected={tab === "fill"} className={tab === "fill" ? "on" : ""} onClick={() => setTab("fill")}>Fill in</button>
    </div>
  );

  if (tab === "fill") return <AgentFormDialog agent={null} tabs={tabs} options={options} onClose={onClose} onSaved={onSaved} />;

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="New agent">
        <h2>New agent</h2>
        {tabs}
        {tab === "template" ? <TemplatePicker onPick={setTemplate} /> : hasArchitect ? <ArchitectChat messages={transcript} setMessages={setTranscript} onProposal={setProposal} onCancel={onClose} /> : <p className="muted">Install Claude Code to use the Architect.</p>}
        {(tab === "template" || !hasArchitect) && (
          <footer className="dialog-foot">
            <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          </footer>
        )}
      </div>
    </div>
  );
}
