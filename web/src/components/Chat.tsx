import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, ApiError, avatarUrl, ENGINE_NAMES, STATUS_LABELS, type Activity, type Agent, type AgentBudget, type ComputerStatus, type Message } from "../api.ts";
import { stepLabel } from "../steps.ts";
import { formatWake } from "../wake.ts";
import { AgentSettings } from "./AgentSettings.tsx";
import { ComputerPanel } from "./ComputerPanel.tsx";

interface Props {
  agent: Agent;
  activity: Activity | undefined;
  computer: ComputerStatus | undefined;
  budget: AgentBudget | undefined;
  connected: boolean;
  draft: string;
  tick: number;
  onEdit: () => void;
  onDeleted: () => void;
}

export function Chat({ agent, activity, computer, budget, connected, draft, tick, onEdit, onDeleted }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    api.messages(agent.id).then(
      (loaded) => current && setMessages(loaded),
      (caught: unknown) => current && setError(caught instanceof ApiError ? caught.message : "Couldn't load messages."),
    );
    return () => {
      current = false;
    };
  }, [agent.id, tick]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, draft]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const message = text.trim();
    if (!message) return;
    setText("");
    setError(null);
    try {
      await api.send(agent.id, message);
    } catch (caught) {
      setText(message);
      setError(caught instanceof ApiError ? caught.message : "Couldn't send.");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${agent.name}? Its chat and workspace are removed.`)) return;
    await api.deleteAgent(agent.id);
    onDeleted();
  };

  return (
    <section className="chat">
      <header className="chat-head">
        <img className="avatar lg" src={avatarUrl(agent)} alt="" />
        <div className="who">
          <h2>{agent.name} <span className="role">· {agent.role}</span></h2>
          <p className="muted">
            <span className={`dot ${agent.status}`} /> {STATUS_LABELS[agent.status]}
            {activity && <> · {stepLabel(activity.detail)}</>}
            {" · "}{ENGINE_NAMES[agent.engine]} · {agent.model === "auto" ? "Auto model" : agent.model}
            {agent.computer === "virtual" && " · Virtual computer"}
            {agent.nextWake && ` · Next wake ${formatWake(agent.nextWake)}`}
          </p>
        </div>
        <div className="actions">
          {activity && <button className="ghost" onClick={() => void api.stop(agent.id)}>Stop</button>}
          <button className="ghost" onClick={() => void api.shuffleAvatar(agent.id)} title="New avatar">🎲</button>
          <button className="ghost" onClick={onEdit}>Edit</button>
          <button className="ghost danger" onClick={() => void remove()}>Delete</button>
        </div>
      </header>

      {agent.computer === "virtual" && <ComputerPanel agent={agent} status={computer ?? { state: "stopped" }} />}

      <AgentSettings agent={agent} budget={budget} connected={connected} />

      <div className="messages">
        {messages.length === 0 && !draft && (
          <div className="empty">
            <img className="avatar xl" src={avatarUrl(agent)} alt="" />
            <p>Say hi to {agent.name}. Ask for anything a {agent.role} would do.</p>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            {message.role === "tool" ? <span className="tool">⚙︎ {stepLabel(message.text)}</span> : message.text}
          </div>
        ))}
        {draft && <div className="message assistant live">{draft}</div>}
        {activity && !draft && <div className="typing">{agent.name} is {activity.detail.toLowerCase().startsWith("thinking") ? "thinking" : "working"}…</div>}
        <div ref={bottom} />
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea rows={2} value={text} placeholder={`Message ${agent.name}…  (Enter to send, Shift+Enter for a new line)`} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} />
        <button type="submit" className="primary" disabled={!text.trim()}>Send</button>
      </form>
      {activity && activity.queued > 0 && <p className="hint pad">{activity.queued} message(s) queued; {agent.name} reads them after the current task.</p>}
      {error && <p className="error pad">{error}</p>}
    </section>
  );
}
