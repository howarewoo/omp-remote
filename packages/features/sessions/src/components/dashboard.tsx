import type { Session } from "@omp-remote/protocol";
import { SESSION_STATUS_LABEL, SESSION_STATUS_TONE } from "@omp-remote/ui";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

const ABORT_THRESHOLD = 88;
type ComposerMode = "prompt" | "steer" | "follow_up";

export interface DashboardProps {
  sessions: Session[];
  totalSessions: number;
  historyLoading: boolean;
  hasMoreHistory: boolean;
  connection: "connecting" | "connected" | "disconnected";
  error: string | null;
  onLaunch(cwd: string, resume: string | null): Promise<void>;
  onCommand(sessionId: string, command: ComposerMode, text: string): Promise<void>;
  onAbort(sessionId: string): Promise<void>;
  onSearchHistory(query: string): Promise<void>;
  onLoadMoreHistory(): Promise<void>;
  onLoadTranscript(sessionId: string): Promise<void>;
}

export function Dashboard({
  sessions,
  totalSessions,
  historyLoading,
  hasMoreHistory,
  connection,
  error,
  onLaunch,
  onCommand,
  onAbort,
  onSearchHistory,
  onLoadMoreHistory,
  onLoadTranscript,
}: DashboardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composerMode, setComposerMode] = useState<ComposerMode>("prompt");
  const [message, setMessage] = useState("");
  const [commandState, setCommandState] = useState<"idle" | "sending">("idle");
  const [commandError, setCommandError] = useState<string | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [abortPull, setAbortPull] = useState(0);
  const [historyQuery, setHistoryQuery] = useState("");
  const [activeHistoryQuery, setActiveHistoryQuery] = useState("");
  const [transcriptLoadingId, setTranscriptLoadingId] = useState<string | null>(null);
  const loadedTranscriptIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
    [selectedId, sessions],
  );

  useEffect(() => {
    if (selectedSession && selectedSession.id !== selectedId) setSelectedId(selectedSession.id);
  }, [selectedId, selectedSession]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [selectedSession?.messages.length, selectedSession?.messages.at(-1)?.text]);

  useEffect(() => {
    if (selectedSession?.source !== "history" || loadedTranscriptIdRef.current === selectedSession.id) return;
    const sessionId = selectedSession.id;
    loadedTranscriptIdRef.current = sessionId;
    setTranscriptLoadingId(sessionId);
    void onLoadTranscript(sessionId)
      .catch(() => {
        if (loadedTranscriptIdRef.current === sessionId) loadedTranscriptIdRef.current = null;
      })
      .finally(() => setTranscriptLoadingId((current) => (current === sessionId ? null : current)));
  }, [onLoadTranscript, selectedSession]);

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

  const submitHistorySearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await onSearchHistory(historyQuery);
      setActiveHistoryQuery(historyQuery.trim());
    } catch {
      return;
    }
  };

  const resumeSelectedSession = async () => {
    if (selectedSession?.source !== "history") return;
    setCommandError(null);
    setCommandState("sending");
    try {
      await onLaunch(selectedSession.cwd, selectedSession.sessionPath ?? selectedSession.id);
    } catch (resumeError) {
      setCommandError(
        resumeError instanceof Error ? resumeError.message : "OMP could not resume this session",
      );
    } finally {
      setCommandState("idle");
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

      <search>
        <form className="catalog-tools" onSubmit={submitHistorySearch}>
          <label>
            <span className="sr-only">Search all local OMP sessions</span>
            <input
              type="search"
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
              placeholder="Search every session by name or path"
              maxLength={200}
            />
          </label>
          <button className="route-action" type="submit" disabled={historyLoading}>
            {historyLoading ? "Searching…" : "Search history"}
          </button>
          <output>
            {totalSessions.toLocaleString()} {totalSessions === 1 ? "session" : "sessions"}
          </output>
        </form>
      </search>
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
              <h2>
                {historyLoading
                  ? "Reading the session archive"
                  : activeHistoryQuery
                    ? "No sessions match this search"
                    : "No routes on the panel"}
              </h2>
              <p>
                {historyLoading
                  ? "Session metadata stays on the host and is being indexed now."
                  : activeHistoryQuery
                    ? "Try a session name, ID, or working-directory path."
                    : "Start a route here or run any terminal OMP session after installing the registration extension."}
              </p>
              {!historyLoading ? (
                <button
                  className="primary-control"
                  type="button"
                  onClick={() => {
                    if (activeHistoryQuery) {
                      setHistoryQuery("");
                      setActiveHistoryQuery("");
                      void onSearchHistory("").catch(() => undefined);
                    } else {
                      setLaunchOpen(true);
                    }
                  }}
                >
                  {activeHistoryQuery ? "Clear search" : "Open first route"}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
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
                      <small>
                        {session.source === "rpc"
                          ? "Remote route"
                          : session.source === "extension"
                            ? "Terminal route"
                            : "Saved session"}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
            {hasMoreHistory ? (
              <button
                className="load-more-control"
                type="button"
                disabled={historyLoading}
                onClick={() => void onLoadMoreHistory().catch(() => undefined)}
              >
                {historyLoading ? "Reading archive…" : "Load older sessions"}
              </button>
            ) : null}
          </>
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

          <div
            ref={transcriptRef}
            className="transcript"
            role="log"
            aria-live="polite"
            aria-label="Session transcript"
          >
            {transcriptLoadingId === selectedSession.id ? (
              <div className="empty-transcript" role="status">
                <strong>Reading session log…</strong>
                <span>Large transcripts stay on the host and load only when selected.</span>
              </div>
            ) : selectedSession.messages.length === 0 ? (
              <div className="empty-transcript">
                <strong>
                  {selectedSession.source === "history"
                    ? "No text messages in this session."
                    : "Route is clear."}
                </strong>
                <span>
                  {selectedSession.source === "history"
                    ? "Resume it to continue working."
                    : "Send the first instruction when you are ready."}
                </span>
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
          </div>

          {selectedSession.source === "history" ? (
            <div className="history-controls">
              <div>
                <span>Archived session</span>
                <strong>Resume this session to send new instructions.</strong>
              </div>
              <button
                className="primary-control"
                type="button"
                disabled={connection !== "connected" || commandState === "sending"}
                onClick={() => void resumeSelectedSession()}
              >
                Resume session
              </button>
              {commandError ? (
                <p className="inline-error" role="alert">
                  {commandError}
                </p>
              ) : null}
            </div>
          ) : (
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
          )}
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
