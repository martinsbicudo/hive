import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, ApiError, type ArchitectMessage, type ArchitectProposal } from "../api.ts";

const MAX_MESSAGE = 8000;
const MAX_MESSAGES = 30;
const MAX_TOTAL = 32000;

function capProblem(history: readonly ArchitectMessage[], text: string): string | null {
  if (text.length > MAX_MESSAGE) return `That message is too long. Keep it under ${MAX_MESSAGE} characters.`;
  if (history.length + 1 > MAX_MESSAGES) return "This conversation got long. Close it and start again, or use Fill in.";
  const total = history.reduce((sum, item) => sum + item.text.length, text.length);
  if (total > MAX_TOTAL) return "This conversation got long. Close it and start again, or use Fill in.";
  return null;
}

interface Props {
  messages: ArchitectMessage[];
  setMessages: (messages: ArchitectMessage[]) => void;
  onProposal: (proposal: ArchitectProposal) => void;
  onCancel: () => void;
}

export function ArchitectChat({ messages, setMessages, onProposal, onCancel }: Props) {
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, thinking]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const message = text.trim();
    if (!message || thinking) return;
    const problem = capProblem(messages, message);
    if (problem) {
      setError(problem);
      return;
    }
    const history: ArchitectMessage[] = [...messages, { role: "user", text: message }];
    setMessages(history);
    setText("");
    setError(null);
    setThinking(true);
    try {
      const answer = await api.architect(history);
      if (answer.reply.trim()) setMessages([...history, { role: "assistant", text: answer.reply }]);
      if (answer.error) setError(answer.error);
      if (answer.proposal) onProposal(answer.proposal);
    } catch (caught) {
      setMessages(messages);
      setText(message);
      setError(caught instanceof ApiError ? caught.message : "Hive didn't answer.");
    } finally {
      setThinking(false);
    }
  };

  const stop = () => {
    api.stopArchitect().catch(() => undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="architect">
      <div className="architect-log" aria-live="polite">
        {messages.length === 0 && <p className="muted">Tell the Architect what you need help with, like “an agent that summarizes the news every morning”. It asks a few short questions, then proposes an agent for you to review. Nothing is created until you click Create.</p>}
        {messages.map((message, index) => <div key={`${index}-${message.role}`} className={`message ${message.role}`}>{message.text}</div>)}
        {thinking && <p className="typing">thinking…</p>}
        <div ref={bottom} />
      </div>
      {error && <p className="error">{error}</p>}
      <form className="composer-stack" onSubmit={submit}>
        <textarea rows={3} value={text} disabled={thinking} placeholder="Describe the agent you want…" aria-label="Message to the Architect" onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} />
        <footer className="dialog-foot">
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          {thinking ? (
            <button type="button" className="ghost danger" onClick={stop}>Stop</button>
          ) : (
            <button type="submit" className="primary" disabled={!text.trim()}>Send</button>
          )}
        </footer>
      </form>
    </div>
  );
}
