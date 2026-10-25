import { useCallback, useEffect, useState } from "react";
import { api, useNeedsToken, type Agent, type HubOptions } from "./api.ts";
import { useLive } from "./live.ts";
import { Board } from "./components/Board.tsx";
import { AgentFormDialog } from "./components/AgentForm.tsx";
import { NewAgentDialog } from "./components/NewAgentDialog.tsx";
import { Chat } from "./components/Chat.tsx";
import { PauseBanner, PauseButton } from "./components/Control.tsx";
import { AgentRow, ApprovalsBar, UsageView } from "./components/Panels.tsx";
import { TokenField } from "./components/TokenField.tsx";
import { Computers } from "./components/Computers.tsx";

type View = "agents" | "board" | "usage" | "computers";
const VIEWS: readonly View[] = ["agents", "board", "usage", "computers"];

function viewFromHash(): View {
  const hash = window.location.hash.replace("#", "").split("/")[0];
  return VIEWS.find((view) => view === hash) ?? "agents";
}

function agentFromHash(): string | null {
  const [, id] = window.location.hash.replace("#", "").split("/");
  return id ?? null;
}

export function App() {
  const { state, connected, drafts, messageTick, taskTick } = useLive();
  const needsToken = useNeedsToken();
  const [options, setOptions] = useState<HubOptions | null>(null);
  const [view, setView] = useState<View>(viewFromHash);
  const [selectedId, setSelectedId] = useState<string | null>(agentFromHash);
  const [editing, setEditing] = useState<Agent | "new" | null>(null);

  useEffect(() => {
    api.options().then(setOptions, () => setOptions(null));
  }, [connected]);

  useEffect(() => {
    const onHash = () => {
      setView(viewFromHash());
      setSelectedId(agentFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((next: View, agentId: string | null = null) => {
    window.location.hash = agentId ? `${next}/${agentId}` : next;
  }, []);

  const saved = (agent: Agent) => {
    setEditing(null);
    go("agents", agent.id);
  };

  const agents = state?.agents ?? [];
  const selected = agents.find((agent) => agent.id === selectedId) ?? (view === "agents" ? agents[0] : undefined);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" role="img" aria-label="Hive"><img className="logo" src="/hive-mark.svg" alt="" /><span className="wordmark" /></div>
        <nav>
          <button className={view === "agents" ? "on" : ""} onClick={() => go("agents", selected?.id)}>Agents</button>
          <button className={view === "board" ? "on" : ""} onClick={() => go("board")}>Board</button>
          <button className={view === "usage" ? "on" : ""} onClick={() => go("usage")}>Usage</button>
          <button className={view === "computers" ? "on" : ""} onClick={() => go("computers")}>Computers</button>
        </nav>
        <div className="agent-list">
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} selected={view === "agents" && agent.id === selected?.id} onSelect={() => go("agents", agent.id)} />
          ))}
        </div>
        {state && <PauseButton paused={state.paused} connected={connected} hasAgents={agents.length > 0} />}
        {!needsToken && <button className="primary new" onClick={() => setEditing("new")} disabled={!options || !connected}>+ New agent</button>}
        {!connected && !needsToken && <p className="offline">Reconnecting to Hive…</p>}
      </aside>

      <main className="main">
        {state && <PauseBanner state={state} connected={connected} />}
        {state && <ApprovalsBar state={state} />}
        {!state && needsToken && <TokenField />}
        {!state && !needsToken && <div className="empty"><p className="muted">Connecting…</p></div>}
        {state && view === "usage" && <UsageView state={state} connected={connected} />}
        {state && view === "computers" && <Computers agents={state.agents} connected={connected} />}
        {state && view === "board" && <Board state={state} tick={taskTick} openTaskId={selectedId} onOpenTask={(id) => go("board", id)} />}
        {state && view === "agents" && selected && (
          <Chat
            key={selected.id}
            agent={selected}
            activity={state.activity.find((item) => item.agentId === selected.id)}
            computer={state.computers.find((item) => item.agentId === selected.id)}
            budget={state.budgets.agents.find((item) => item.agentId === selected.id)}
            connected={connected}
            draft={drafts[selected.id] ?? ""}
            tick={messageTick[selected.id] ?? 0}
            onEdit={() => setEditing(selected)}
            onDeleted={() => go("agents")}
          />
        )}
        {state && view === "agents" && !selected && (
          <div className="empty">
            <h2>Your hive is empty</h2>
            <p className="muted">Create an agent: give it a role like “Software Engineer” or “Lead Hunter”, pick Claude Code or Codex, and start talking.</p>
            <button className="primary" onClick={() => setEditing("new")} disabled={!options || !connected}>Create your first agent</button>
          </div>
        )}
      </main>

      {editing && options && (
        editing === "new" ? (
          <NewAgentDialog options={options} onClose={() => setEditing(null)} onSaved={saved} />
        ) : (
          <AgentFormDialog agent={editing} options={options} onClose={() => setEditing(null)} onSaved={saved} />
        )
      )}
    </div>
  );
}
