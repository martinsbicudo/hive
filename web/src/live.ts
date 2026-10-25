import { useEffect, useState } from "react";
import { api, readyToken } from "./api.ts";
import { hubEvent, type HubState } from "./schemasState.ts";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const RECONNECT_MS = 1500;

export interface Live {
  state: HubState | null;
  connected: boolean;
  drafts: Record<string, string>;
  messageTick: Record<string, number>;
  taskTick: number;
}

export function useLive(): Live {
  const [state, setState] = useState<HubState | null>(null);
  const [connected, setConnected] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messageTick, setMessageTick] = useState<Record<string, number>>({});
  const [taskTick, setTaskTick] = useState(0);
  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    const connect = async () => {
      const token = await readyToken();
      if (closed || !token) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      let opened = false;
      socket = new WebSocket(`${scheme}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      socket.onopen = () => {
        opened = true;
        setConnected(true);
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        if (!opened) api.options().catch(() => undefined);
        retry = window.setTimeout(() => void connect(), RECONNECT_MS);
      };
      socket.onmessage = (message) => {
        const parsed = hubEvent.safeParse(parseJson(String(message.data)));
        if (!parsed.success) {
          console.error("Hive sent a live update the board doesn't understand", parsed.error.issues[0]?.path.join("."));
          return;
        }
        const event = parsed.data;
        if (event.type === "state") setState(event.state);
        if (event.type === "delta") setDrafts((current) => ({ ...current, [event.agentId]: (current[event.agentId] ?? "") + event.text }));
        if (event.type === "task") setTaskTick((current) => current + 1);
        if (event.type === "message") {
          setDrafts((current) => ({ ...current, [event.agentId]: "" }));
          setMessageTick((current) => ({ ...current, [event.agentId]: (current[event.agentId] ?? 0) + 1 }));
        }
      };
    };
    void connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return { state, connected, drafts, messageTick, taskTick };
}
