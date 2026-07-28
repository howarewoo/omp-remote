import { type BrowserCommand, type Session, ServerFrameSchema } from "@omp-remote/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

const RECONNECT_DELAY_MS = 1_500;

type ConnectionState = "connecting" | "connected" | "disconnected";
type PendingCommand = { resolve: () => void; reject: (error: Error) => void };

export interface SessionClient {
  sessions: Session[];
  connection: ConnectionState;
  error: string | null;
  launch(cwd: string, resume: string | null): Promise<void>;
  command(sessionId: string, command: "prompt" | "steer" | "follow_up", text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
}

export function useSessionClient(): SessionClient {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, PendingCommand>());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (disposed) return;
      setConnection("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        setConnection("connected");
        setError(null);
      });
      socket.addEventListener("message", (event) => {
        const frame = (() => {
          try {
            return ServerFrameSchema.parse(JSON.parse(String(event.data)));
          } catch {
            setError("The host sent an unreadable update. Reconnect to restore the dashboard.");
            return null;
          }
        })();
        if (!frame) return;
        if (frame.type === "snapshot") setSessions(frame.sessions);
        else if (frame.type === "session_upsert") {
          setSessions((current) => {
            const withoutCurrent = current.filter((session) => session.id !== frame.session.id);
            return [frame.session, ...withoutCurrent].sort((left, right) =>
              right.lastActivity.localeCompare(left.lastActivity),
            );
          });
        } else if (frame.type === "session_removed") {
          setSessions((current) => current.filter((session) => session.id !== frame.sessionId));
        } else if (frame.type === "command_result") {
          const pending = pendingRef.current.get(frame.requestId);
          if (!pending) return;
          pendingRef.current.delete(frame.requestId);
          if (frame.ok) pending.resolve();
          else pending.reject(new Error(frame.error ?? "The host rejected the command"));
        } else if (frame.type === "error") {
          setError(frame.message);
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        setConnection("disconnected");
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      });
      socket.addEventListener("error", () => socket.close());
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      for (const pending of pendingRef.current.values()) pending.reject(new Error("Dashboard disconnected"));
      pendingRef.current.clear();
    };
  }, []);

  const send = useCallback((frame: BrowserCommand): Promise<void> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("The host is not connected"));
    }
    return new Promise<void>((resolve, reject) => {
      pendingRef.current.set(frame.requestId, { resolve, reject });
      socket.send(JSON.stringify(frame));
    });
  }, []);

  const launch = useCallback(
    (cwd: string, resume: string | null) =>
      send({ type: "launch", requestId: crypto.randomUUID(), cwd, resume }),
    [send],
  );
  const command = useCallback(
    (sessionId: string, commandName: "prompt" | "steer" | "follow_up", text: string) =>
      send({
        type: "session_command",
        requestId: crypto.randomUUID(),
        sessionId,
        command: commandName,
        text,
      }),
    [send],
  );
  const abort = useCallback(
    (sessionId: string) =>
      send({ type: "session_command", requestId: crypto.randomUUID(), sessionId, command: "abort" }),
    [send],
  );

  return { sessions, connection, error, launch, command, abort };
}
