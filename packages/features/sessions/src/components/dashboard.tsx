import type { Session } from "@omp-remote/protocol";
import { SESSION_STATUS_LABEL, SESSION_STATUS_TONE } from "@omp-remote/ui";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

const ABORT_THRESHOLD = 88;
type ComposerMode = "prompt" | "steer" | "follow_up";

export interface DashboardProps {
  sessions: Session[];
  connection: "connecting" | "connected" | "disconnected";
  error: string | null;
  onLaunch(cwd: string, resume: string | null): Promise<void>;
  onCommand(sessionId: string, command: ComposerMode, text: string): Promise<void>;
  onAbort(sessionId: string): Promise<void>;
}

export function Dashboard({ sessions, connection, error, onLaunch, onCommand, onAbort }: DashboardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composerMode, setComposerMode] = useState<ComposerMode>("prompt");
  const [message, setMessage] = useState("");
  const [commandState, setCommandState] = useState<"idle" | "sending">("idle");
  const [commandError, setCommandError] = useState<string | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [abortPull, setAbortPull] = useState(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
    [selectedId, sessions],
  );

  useEffect(() => {
    if (selectedSession && selectedSession.id !== selectedId) setSelectedId(selectedSession.id);
  }, [selectedId, selectedSession]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedSession?.messages.length, selectedSession?.messages.at(-1)?.text]);

  const submitMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSession || !message.trim() || commandState === "sending") return;
    setCommandState("sending");
    setCommandError(null);
    try {
      await onCommand(selectedSession.id, composerMode, message.trim());
      setMessage("");
    } catch (submissionError) {
      setCommandError(
        submissionError instanceof Error ? submissionError.message : "The command did not reach OMP",
      );
    } finally {
      setCommandState("idle");
    }
  };

  const submitLaunch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const cwd = String(form.get("cwd") ?? "").trim();
    const resume = String(form.get("resume") ?? "").trim() || null;
    if (!cwd) return;
    setLaunchError(null);
    try {
      await onLaunch(cwd, resume);
      setLaunchOpen(false);
      event.currentTarget.reset();
    } catch (submissionError) {
      setLaunchError(
        submissionError instanceof Error ? submissionError.message : "OMP could not start this route",
      );
    }
  };

  const commitAbort = async () => {
    if (!selectedSession || abortPull < ABORT_THRESHOLD) {
      setAbortPull(0);
      return;
    }
    setCommandError(null);
    try {
      await onAbort(selectedSession.id);
    } catch (abortError) {
      setCommandError(
        abortError instanceof Error ? abortError.message : "OMP did not acknowledge the interrupt",
      );
    } finally {
      setAbortPull(0);
    }
  };

  return (
    <main className="dashboard-shell">
      <header className="control-header">
        <div>
          <p className="plate-label">OMP Remote · Interlocking panel</p>
          <h1>Session routes</h1>
        </div>
        <div className="header-actions">
          <span className={`connection-state connection-${connection}`}>
            <span aria-hidden="true" className="connection-lamp" />
            {connection === "connected"
              ? "Tailnet link clear"
              : connection === "connecting"
                ? "Finding host"
                : "Host link lost"}
          </span>
          <button className="route-action" type="button" onClick={() => setLaunchOpen((open) => !open)}>
            {launchOpen ? "Close route desk" : "New route"}
          </button>
        </div>
      </header>

      {launchOpen ? (
        <form className="launch-bay" onSubmit={submitLaunch}>
          <div className="launch-copy">
            <strong>Open an RPC route</strong>
            <span>Start in a working directory, or resume a saved OMP session.</span>
          </div>
          <label>
            Working directory
            <input name="cwd" required placeholder="/Users/you/project" autoComplete="off" />
          </label>
          <label>
            Resume ID or path <span>(optional)</span>
            <input name="resume" placeholder="Session ID or .jsonl path" autoComplete="off" />
          </label>
          <button className="primary-control" type="submit">
            Set route
          </button>
          {launchError ? (
            <p className="inline-error" role="alert">
              {launchError}
            </p>
          ) : null}
        </form>
      ) : null}

      {error ? (
        <p className="system-alert" role="alert">
          {error}
        </p>
      ) : null}

      <section className="route-board" aria-label="Registered OMP sessions">
        <div className="board-legend" aria-hidden="true">
          <span>
            <i className="legend-lamp lamp-running" />
            Running
          </span>
          <span>
            <i className="legend-lamp lamp-waiting" />
            Waiting
          </span>
          <span>
            <i className="legend-lamp lamp-clear" />
            Clear
          </span>
        </div>
        {sessions.length === 0 ? (
          <div className="empty-routes">
            <div className="empty-signal" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div>
              <h2>No routes on the panel</h2>
              <p>
                Start a route here or run any terminal OMP session after installing the registration
                extension.
              </p>
              <button className="primary-control" type="button" onClick={() => setLaunchOpen(true)}>
                Open first route
              </button>
            </div>
          </div>
        ) : (
          <div className="routes">
            {sessions.map((session, index) => {
              const selected = session.id === selectedSession?.id;
              const tone = SESSION_STATUS_TONE[session.status];
              return (
                <button
                  className={`route-line${selected ? " route-selected" : ""}`}
                  type="button"
                  key={session.id}
                  aria-pressed={selected}
                  onClick={() => setSelectedId(session.id)}
                >
                  <span className="route-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="route-rail" aria-hidden="true">
                    <i />
                    <i />
                  </span>
                  <span className={`signal signal-${tone}`} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="route-identity">
                    <strong>
                      {session.name ?? session.cwd.split("/").filter(Boolean).at(-1) ?? "Untitled session"}
                    </strong>
                    <small>{session.cwd}</small>
                  </span>
                  <span className="route-meta">
                    <b>{SESSION_STATUS_LABEL[session.status]}</b>
                    <small>{session.source === "rpc" ? "Remote route" : "Terminal route"}</small>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selectedSession ? (
        <section
          className="working-bay"
          aria-label={`Controls for ${selectedSession.name ?? selectedSession.cwd}`}
        >
          <div className="session-instruments">
            <div>
              <span>Selected route</span>
              <strong>{selectedSession.name ?? "Untitled session"}</strong>
            </div>
            <div>
              <span>Model</span>
              <strong>{selectedSession.model ?? "Default model"}</strong>
            </div>
            <div>
              <span>Context</span>
              <strong>
                {selectedSession.contextPercent === null
                  ? "—"
                  : `${Math.round(selectedSession.contextPercent)}%`}
              </strong>
            </div>
            <div>
              <span>Last movement</span>
              <strong>
                <time dateTime={selectedSession.lastActivity}>
                  {formatTime(selectedSession.lastActivity)}
                </time>
              </strong>
            </div>
          </div>

          <div className="transcript" role="log" aria-live="polite" aria-label="Session transcript">
            {selectedSession.messages.length === 0 ? (
              <div className="empty-transcript">
                <strong>Route is clear.</strong>
                <span>Send the first instruction when you are ready.</span>
              </div>
            ) : (
              selectedSession.messages.map((entry) => (
                <article className={`transcript-entry transcript-${entry.role}`} key={entry.id}>
                  <header>
                    <span>
                      {entry.role === "assistant" ? "OMP" : entry.role === "user" ? "You" : entry.role}
                    </span>
                    <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time>
                    {entry.streaming ? <i className="streaming-mark">Receiving</i> : null}
                  </header>
                  <p>{entry.text || "…"}</p>
                </article>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>

          <div className="control-desk">
            <form className="composer" onSubmit={submitMessage}>
              <fieldset className="mode-switch" aria-label="Command delivery mode">
                {(["prompt", "steer", "follow_up"] as const).map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    aria-pressed={composerMode === mode}
                    onClick={() => setComposerMode(mode)}
                    disabled={!selectedSession.capabilities.includes(mode)}
                  >
                    {mode === "follow_up" ? "Follow up" : mode[0]?.toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </fieldset>
              <label className="composer-field">
                <span>
                  {composerMode === "prompt"
                    ? "New instruction"
                    : composerMode === "steer"
                      ? "Steer current run"
                      : "Queue after run"}
                </span>
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Tell OMP what to do next"
                  rows={3}
                />
              </label>
              <button
                className="send-control"
                type="submit"
                disabled={!message.trim() || commandState === "sending"}
              >
                {commandState === "sending"
                  ? "Sending…"
                  : composerMode === "steer"
                    ? "Steer now"
                    : composerMode === "follow_up"
                      ? "Queue follow-up"
                      : "Send prompt"}
              </button>
              {commandError ? (
                <p className="inline-error" role="alert">
                  {commandError}
                </p>
              ) : null}
            </form>

            <div className="abort-control">
              <div>
                <span>Emergency interrupt</span>
                <small>Pull past the marked release point</small>
              </div>
              <div className={`abort-track${abortPull >= ABORT_THRESHOLD ? " abort-armed" : ""}`}>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={abortPull}
                  aria-label="Pull to interrupt the selected OMP session"
                  disabled={
                    !selectedSession.capabilities.includes("abort") || selectedSession.status !== "running"
                  }
                  onChange={(event) => setAbortPull(Number(event.target.value))}
                  onPointerUp={commitAbort}
                  onKeyUp={(event) => {
                    if (event.key === "Enter" || event.key === " ") void commitAbort();
                  }}
                />
                <span className="abort-threshold" aria-hidden="true">
                  Release
                </span>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
