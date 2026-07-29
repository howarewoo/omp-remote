import type { Session } from "@omp-remote/protocol";
import { SESSION_STATUS_LABEL, SESSION_STATUS_TONE } from "@omp-remote/ui";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Separator } from "./ui/separator.js";
import { Textarea } from "./ui/textarea.js";
import { cn } from "./ui/utils.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar.js";

type ComposerMode = "prompt" | "steer" | "follow_up";
type SessionSection = {
  id: "connected" | "disconnected";
  label: "Connected" | "Disconnected";
  sessions: Session[];
};

export function groupSessionsByConnection(sessions: Session[]): SessionSection[] {
  const connected: Session[] = [];
  const disconnected: Session[] = [];

  for (const session of sessions) {
    (session.connected ? connected : disconnected).push(session);
  }

  const sections: SessionSection[] = [
    { id: "connected", label: "Connected", sessions: connected },
    { id: "disconnected", label: "Disconnected", sessions: disconnected },
  ];
  return sections.filter((section) => section.sessions.length > 0);
}

export function formatSubagentActivityLabel(count: number): string {
  return `${count} ${count === 1 ? "subagent" : "subagents"} running`;
}

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

export function Dashboard(props: DashboardProps) {
  return (
    <SidebarProvider>
      <DashboardContent {...props} />
    </SidebarProvider>
  );
}

function DashboardContent({
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
  const [abortOpen, setAbortOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [activeHistoryQuery, setActiveHistoryQuery] = useState("");
  const [transcriptLoadingId, setTranscriptLoadingId] = useState<string | null>(null);
  const loadedTranscriptIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const followTranscriptRef = useRef(true);
  const { closeMobile } = useSidebar();

  const sessionSections = useMemo(() => groupSessionsByConnection(sessions), [sessions]);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessionSections[0]?.sessions[0] ?? null,
    [selectedId, sessionSections, sessions],
  );

  useEffect(() => {
    if (selectedSession && selectedSession.id !== selectedId) setSelectedId(selectedSession.id);
  }, [selectedId, selectedSession]);

  useEffect(() => {
    followTranscriptRef.current = true;
  }, [selectedSession?.id]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followTranscriptRef.current) transcript.scrollTop = transcript.scrollHeight;
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
    } catch (commandFailure) {
      setCommandError(
        commandFailure instanceof Error ? commandFailure.message : "The instruction could not be sent",
      );
    } finally {
      setCommandState("idle");
    }
  };

  const submitLaunch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const cwd = String(form.get("cwd") ?? "").trim();
    const resume = String(form.get("resume") ?? "").trim();
    if (!cwd) return;
    setLaunchError(null);
    try {
      await onLaunch(cwd, resume || null);
      setLaunchOpen(false);
      event.currentTarget.reset();
    } catch (launchFailure) {
      setLaunchError(
        launchFailure instanceof Error ? launchFailure.message : "OMP could not start the session",
      );
    }
  };

  const submitHistorySearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = historyQuery.trim();
    try {
      await onSearchHistory(query);
      setActiveHistoryQuery(query);
    } catch {
      // The shared client exposes the actionable request error above the session list.
    }
  };

  const resumeSelectedSession = async () => {
    if (!selectedSession?.sessionPath || commandState === "sending") return;
    setCommandState("sending");
    setCommandError(null);
    try {
      await onLaunch(selectedSession.cwd, selectedSession.sessionPath);
    } catch (resumeFailure) {
      setCommandError(
        resumeFailure instanceof Error ? resumeFailure.message : "The session could not be resumed",
      );
    } finally {
      setCommandState("idle");
    }
  };

  const abortSelectedSession = async () => {
    if (!selectedSession) return;
    setCommandState("sending");
    setCommandError(null);
    try {
      await onAbort(selectedSession.id);
      setAbortOpen(false);
    } catch (abortFailure) {
      setCommandError(
        abortFailure instanceof Error ? abortFailure.message : "The active run could not be interrupted",
      );
    } finally {
      setCommandState("idle");
    }
  };

  return (
    <div className="app-shell">
      <Sidebar>
        <SidebarHeader>
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              π
            </span>
            <span className="brand-word">omp</span>
            <span className="brand-remote">remote</span>
          </div>
          <SidebarTrigger />
        </SidebarHeader>

        <div className="sidebar-actions">
          <Button type="button" onClick={() => setLaunchOpen(true)} className="new-session-button">
            <Icon name="plus" />
            <span>New session</span>
          </Button>
          <form className="session-search" onSubmit={submitHistorySearch}>
            <div className="session-search-field">
              <label className="sr-only" htmlFor="session-search-input">
                Search all local OMP sessions
              </label>
              <Icon name="search" />
              <Input
                id="session-search-input"
                type="search"
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
                placeholder="Search sessions"
                maxLength={200}
              />
            </div>
          </form>
        </div>

        <SidebarContent>
          <div className="session-list-heading">
            <span>Sessions</span>
            <span>{totalSessions.toLocaleString()}</span>
          </div>
          <nav className="session-list" aria-label="Registered OMP sessions">
            {sessions.length === 0 ? (
              <div className="sidebar-empty" role="status">
                <span className="status-orbit" aria-hidden="true" />
                <strong>{historyLoading ? "Reading session history" : "No sessions found"}</strong>
                <p>
                  {activeHistoryQuery
                    ? "Try another name, ID, or working directory."
                    : "Start a session here or connect a terminal session."}
                </p>
                {!historyLoading ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
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
                    {activeHistoryQuery ? "Clear search" : "Start session"}
                  </Button>
                ) : null}
              </div>
            ) : (
              sessionSections.map((section) => (
                <section
                  className="session-group"
                  aria-labelledby={`session-group-${section.id}`}
                  key={section.id}
                >
                  <h2 className="session-group-heading" id={`session-group-${section.id}`}>
                    <span>{section.label}</span>
                    <span>
                      {section.sessions.length.toLocaleString()}
                      <span className="sr-only">
                        {" "}
                        {section.sessions.length === 1 ? "session" : "sessions"}
                      </span>
                    </span>
                  </h2>
                  {section.sessions.map((session) => {
                    const selected = session.id === selectedSession?.id;
                    const displayName =
                      session.name ?? session.cwd.split("/").filter(Boolean).at(-1) ?? "Untitled session";
                    return (
                      <button
                        className={cn("session-item", selected && "session-item-selected")}
                        type="button"
                        key={session.id}
                        aria-current={selected ? "page" : undefined}
                        aria-label={`${displayName}, ${SESSION_STATUS_LABEL[session.status]}`}
                        title={displayName}
                        onClick={() => {
                          setSelectedId(session.id);
                          closeMobile();
                        }}
                      >
                        <span
                          className={cn(
                            "session-state-dot",
                            `session-state-${SESSION_STATUS_TONE[session.status]}`,
                          )}
                        />
                        <span className="session-copy">
                          <strong>{displayName}</strong>
                          <small>{compactPath(session.cwd)}</small>
                        </span>
                        <time dateTime={session.lastActivity}>{formatTime(session.lastActivity)}</time>
                      </button>
                    );
                  })}
                </section>
              ))
            )}
          </nav>
          {hasMoreHistory ? (
            <Button
              className="load-more-button"
              type="button"
              variant="ghost"
              size="sm"
              disabled={historyLoading}
              onClick={() => void onLoadMoreHistory().catch(() => undefined)}
            >
              {historyLoading ? "Reading history…" : "Load older sessions"}
            </Button>
          ) : null}
        </SidebarContent>

        <SidebarFooter>
          <span className={cn("connection-dot", `connection-${connection}`)} aria-hidden="true" />
          <span>
            {connection === "connected"
              ? "Host connected"
              : connection === "connecting"
                ? "Connecting"
                : "Host offline"}
          </span>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="session-header">
          <div className="session-header-primary">
            <SidebarTrigger />
            {selectedSession ? (
              <>
                <div>
                  <h1>{selectedSession.name ?? "Untitled session"}</h1>
                  <p>{selectedSession.cwd}</p>
                </div>
                <Badge
                  className={cn("status-badge", `status-${SESSION_STATUS_TONE[selectedSession.status]}`)}
                >
                  <span aria-hidden="true" />
                  {SESSION_STATUS_LABEL[selectedSession.status]}
                </Badge>
              </>
            ) : (
              <h1>OMP Remote</h1>
            )}
          </div>
          <Button type="button" variant="outline" onClick={() => setLaunchOpen(true)}>
            <Icon name="plus" />
            New session
          </Button>
        </header>

        {error ? (
          <div className="system-alert" role="alert">
            <strong>Live connection needs attention.</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {selectedSession ? (
          <section
            className="session-workspace"
            aria-label={`Controls for ${selectedSession.name ?? selectedSession.cwd}`}
          >
            <div className="session-overview">
              <div className="session-title-block">
                <span className="session-source">
                  {selectedSession.source === "rpc"
                    ? "Remote session"
                    : selectedSession.source === "extension"
                      ? "Terminal session"
                      : "Saved session"}
                </span>
                <h2>
                  {selectedSession.name ??
                    selectedSession.cwd.split("/").filter(Boolean).at(-1) ??
                    "Untitled session"}
                </h2>
              </div>
              <dl className="session-metadata">
                <div>
                  <dt>Model</dt>
                  <dd>{selectedSession.model ?? "Default"}</dd>
                </div>
                <div>
                  <dt>Context</dt>
                  <dd>
                    {selectedSession.contextPercent === null
                      ? "—"
                      : `${Math.round(selectedSession.contextPercent)}%`}
                  </dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>
                    <time dateTime={selectedSession.lastActivity}>
                      {formatTime(selectedSession.lastActivity)}
                    </time>
                  </dd>
                </div>
              </dl>
            </div>

            {selectedSession.activeSubagents.length > 0 ? (
              <section className="subagent-activity" aria-label="Active subagents" aria-live="polite">
                <strong className="subagent-activity-heading">
                  {formatSubagentActivityLabel(selectedSession.activeSubagents.length)}
                </strong>
                <ul className="subagent-list">
                  {selectedSession.activeSubagents.slice(0, 5).map((subagent) => (
                    <li key={subagent.id}>
                      <span>{subagent.name}</span>
                      <time dateTime={subagent.lastActivity}>{formatTime(subagent.lastActivity)}</time>
                    </li>
                  ))}
                  {selectedSession.activeSubagents.length > 5 ? (
                    <li className="subagent-overflow">
                      <span>+{selectedSession.activeSubagents.length - 5} more</span>
                    </li>
                  ) : null}
                </ul>
              </section>
            ) : null}

            <Separator />

            <div
              ref={transcriptRef}
              className="transcript"
              role="log"
              aria-live="polite"
              aria-label="Session transcript"
              onScroll={(event) => {
                const target = event.currentTarget;
                followTranscriptRef.current =
                  target.scrollHeight - target.scrollTop - target.clientHeight < 80;
              }}
            >
              {transcriptLoadingId === selectedSession.id ? (
                <div className="empty-transcript" role="status">
                  <span className="status-orbit" aria-hidden="true" />
                  <strong>Reading session transcript</strong>
                  <p>Large transcripts stay on the host and load only when selected.</p>
                </div>
              ) : selectedSession.messages.length === 0 ? (
                <div className="empty-transcript">
                  <span className="terminal-prompt" aria-hidden="true">
                    π
                  </span>
                  <strong>
                    {selectedSession.source === "history"
                      ? "No text messages in this session"
                      : "Ready for an instruction"}
                  </strong>
                  <p>
                    {selectedSession.source === "history"
                      ? "Resume the session to continue working."
                      : "Prompt OMP below. Live output will appear here as it arrives."}
                  </p>
                </div>
              ) : (
                selectedSession.messages.map((entry) => (
                  <article className={cn("transcript-entry", `transcript-${entry.role}`)} key={entry.id}>
                    <header>
                      <span className="message-author">
                        <i aria-hidden="true">
                          {entry.role === "assistant" ? "π" : entry.role === "user" ? "›" : "·"}
                        </i>
                        {entry.role === "assistant" ? "OMP" : entry.role === "user" ? "You" : entry.role}
                      </span>
                      <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time>
                      {entry.streaming ? <Badge className="streaming-badge">Streaming</Badge> : null}
                    </header>
                    <p>{entry.text || "…"}</p>
                  </article>
                ))
              )}
            </div>

            {selectedSession.source === "history" ? (
              <div className="history-controls">
                <div>
                  <strong>Saved session</strong>
                  <span>Resume this transcript to send new instructions.</span>
                </div>
                <Button
                  type="button"
                  disabled={connection !== "connected" || commandState === "sending"}
                  onClick={() => void resumeSelectedSession()}
                >
                  Resume session
                </Button>
              </div>
            ) : (
              <form className="composer" onSubmit={submitMessage}>
                <div className="composer-toolbar">
                  <fieldset className="mode-switch" aria-label="Command delivery mode">
                    {(["prompt", "steer", "follow_up"] as const).map((mode) => (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        key={mode}
                        aria-pressed={composerMode === mode}
                        onClick={() => setComposerMode(mode)}
                        disabled={!selectedSession.capabilities.includes(mode)}
                      >
                        {mode === "follow_up" ? "Follow up" : mode[0]?.toUpperCase() + mode.slice(1)}
                      </Button>
                    ))}
                  </fieldset>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="abort-button"
                    disabled={
                      !selectedSession.capabilities.includes("abort") || selectedSession.status !== "running"
                    }
                    onClick={() => setAbortOpen(true)}
                  >
                    <Icon name="stop" />
                    Abort
                  </Button>
                </div>
                <div className="composer-field">
                  <label className="sr-only" htmlFor="composer-message">
                    {composerMode === "prompt"
                      ? "New instruction"
                      : composerMode === "steer"
                        ? "Steer current run"
                        : "Queue after run"}
                  </label>
                  <Textarea
                    id="composer-message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder={
                      composerMode === "steer"
                        ? "Redirect the current run…"
                        : composerMode === "follow_up"
                          ? "Queue the next instruction…"
                          : "Ask OMP to build, investigate, or change something…"
                    }
                    rows={3}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                        event.currentTarget.form?.requestSubmit();
                    }}
                  />
                  <Button
                    className="send-button"
                    type="submit"
                    size="icon"
                    disabled={!message.trim() || commandState === "sending"}
                    aria-label={commandState === "sending" ? "Sending instruction" : "Send instruction"}
                  >
                    <Icon name="send" />
                  </Button>
                </div>
                <div className="composer-footer">
                  <span>⌘ ↵ to send</span>
                  {selectedSession.status === "running" ? (
                    <span className="live-copy">Live output connected</span>
                  ) : null}
                </div>
              </form>
            )}

            {commandError ? (
              <p className="inline-error" role="alert">
                {commandError}
              </p>
            ) : null}
          </section>
        ) : (
          <section className="no-session">
            <span className="terminal-prompt" aria-hidden="true">
              π
            </span>
            <h2>Start a session from anywhere.</h2>
            <p>
              Launch OMP here or connect a terminal session on this host. Updates stream into this workspace
              live.
            </p>
            <Button type="button" onClick={() => setLaunchOpen(true)}>
              <Icon name="plus" />
              Start session
            </Button>
          </section>
        )}
      </SidebarInset>

      <Dialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        title="Start an OMP session"
        description="Choose a working directory. Add a saved session ID or JSONL path to resume it."
      >
        <form className="launch-form" onSubmit={submitLaunch}>
          <label htmlFor="launch-cwd">
            <span>Working directory</span>
            <Input
              id="launch-cwd"
              name="cwd"
              required
              placeholder="/Users/you/project"
              autoComplete="off"
              autoFocus
            />
          </label>
          <label htmlFor="launch-resume">
            <span>
              Resume ID or path <small>Optional</small>
            </span>
            <Input
              id="launch-resume"
              name="resume"
              placeholder="Session ID or .jsonl path"
              autoComplete="off"
            />
          </label>
          {launchError ? (
            <p className="inline-error" role="alert">
              {launchError}
            </p>
          ) : null}
          <footer className="dialog-actions">
            <Button type="button" variant="ghost" onClick={() => setLaunchOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Start session</Button>
          </footer>
        </form>
      </Dialog>

      <Dialog
        open={abortOpen}
        onOpenChange={setAbortOpen}
        title="Abort this run?"
        description="OMP will stop the active run. The session and transcript stay available."
      >
        <footer className="dialog-actions">
          <Button type="button" variant="ghost" onClick={() => setAbortOpen(false)}>
            Keep running
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={commandState === "sending"}
            onClick={() => void abortSelectedSession()}
          >
            Abort run
          </Button>
        </footer>
      </Dialog>
    </div>
  );
}

function Icon({ name }: { name: "plus" | "search" | "send" | "stop" }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    search: <path d="m21 21-4.4-4.4m2.4-5.1a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" />,
    send: <path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
  } as const;
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function compactPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) return path;
  return `…/${segments.slice(-2).join("/")}`;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
