import {
  type ActiveSubagent,
  type AskRequest,
  type AskResponse,
  type Session,
  type TranscriptHistoryStatus,
} from "@omp-remote/protocol";
import type { DashboardTranscriptHistoryState, QueuedMessage } from "../dashboard-props.js";
import { AskToolCall } from "../ask/ask-tool-call.js";
import { formatSubagentActivityLabel } from "../dashboard-actions.js";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "../ui/message-scroller.js";
import { Button } from "../ui/button.js";
import { Badge } from "../ui/badge.js";
import {
  MessageScrollerScrollController,
  renderTranscriptMessageItems,
} from "../transcript/transcript-entry.js";
import { DashboardIcon } from "./session-header.js";
import { formatSessionTime } from "./session-sidebar.js";

export interface SessionTranscriptProps {
  queuedMessages: readonly QueuedMessage[];
  session: Session;
  transcriptHistory: DashboardTranscriptHistoryState;
  activeAskRequest: AskRequest | null;
  connection: "connecting" | "connected" | "disconnected";
  onCancelQueuedMessage(messageId: string): void;
  onRespondToAsk(request: AskRequest, response: AskResponse): Promise<void>;
  onAskActivity(request: AskRequest): Promise<void>;
  onViewSubagent(subagent: ActiveSubagent): void;
  onRegisterScrollToEnd(handler: (() => void) | null): void;
  onLoadOlderTranscript(): Promise<void>;
  onRetryTranscript(): Promise<void>;
  onReloadTranscript(): Promise<void>;
}
export function SessionTranscript({
  queuedMessages,
  session,
  transcriptHistory,
  activeAskRequest,
  connection,
  onCancelQueuedMessage,
  onRespondToAsk,
  onAskActivity,
  onViewSubagent,
  onRegisterScrollToEnd,
  onLoadOlderTranscript,
  onRetryTranscript,
  onReloadTranscript,
}: SessionTranscriptProps) {
  const isLoading = transcriptHistory.initialLoading || transcriptHistory.olderLoading;
  const statusLabel =
    transcriptHistory.status === "invalidated"
      ? "Transcript invalidated on host"
      : transcriptHistory.status === "unavailable"
        ? "Earlier messages unavailable"
        : transcriptHistory.status === "available"
          ? "Earlier messages available"
          : transcriptHistory.status === "complete"
            ? "Start of session"
            : null;

  const statusItem =
    transcriptHistory.initialLoading || transcriptHistory.olderLoading ? (
      <div className="transcript-history-status" role="status" aria-live="polite">
        <span className="transcript-history-message">
          {transcriptHistory.initialLoading ? "Loading recent messages…" : "Loading earlier messages…"}
        </span>
      </div>
    ) : transcriptHistory.error ? (
      <div className="transcript-history-status" data-state="error">
        <span className="transcript-history-message" role="alert">
          Transcript history could not be loaded.
        </span>
        <div className="transcript-history-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isLoading}
            onClick={() => void onRetryTranscript().catch(() => undefined)}
          >
            Retry
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isLoading}
            onClick={() => void onReloadTranscript().catch(() => undefined)}
          >
            Reload history
          </Button>
        </div>
      </div>
    ) : statusLabel ? (
      <div className="transcript-history-status" data-state={transcriptHistory.status ?? undefined}>
        <span className="transcript-history-message" role="status" aria-live="polite">
          {statusLabel}
        </span>
        {transcriptHistory.status !== "unavailable" ? (
          <div className="transcript-history-actions">
            {transcriptHistory.status === "available" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isLoading}
                onClick={() => void onLoadOlderTranscript().catch(() => undefined)}
              >
                Load earlier
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isLoading}
              onClick={() => void onReloadTranscript().catch(() => undefined)}
            >
              Reload history
            </Button>
          </div>
        ) : null}
      </div>
    ) : null;
  return (
    <>
      <MessageScrollerProvider
        key={session.id}
        autoScroll
        defaultScrollPosition="end"
        scrollEdgeThreshold={80}
      >
        <MessageScroller className="transcript-region">
          <MessageScrollerViewport
            className="transcript"
            aria-label="Session transcript"
            preserveScrollOnPrepend
            onScroll={(event) => {
              const target = event.currentTarget;
              if (
                target.scrollTop <= 96 &&
                transcriptHistory.status === "available" &&
                !transcriptHistory.initialLoading &&
                !transcriptHistory.olderLoading &&
                !transcriptHistory.error
              ) {
                void onLoadOlderTranscript().catch(() => undefined);
              }
            }}
          >
            <MessageScrollerContent
              className="transcript-messages"
              role="log"
              aria-live="polite"
              aria-busy={session.messages.at(-1)?.streaming === true}
            >
              {!isLoading &&
              session.messages.length === 0 &&
              queuedMessages.length === 0 &&
              !activeAskRequest ? (
                <MessageScrollerItem messageId={`transcript-empty:${session.id}`}>
                  <div className="empty-transcript">
                    <span className="terminal-prompt" aria-hidden="true">
                      π
                    </span>
                    <strong>
                      {session.source === "history"
                        ? "No text messages in this session"
                        : "Ready for an instruction"}
                    </strong>
                    <p>
                      {session.source === "history"
                        ? "Resume the session to continue working."
                        : "Prompt OMP below. Live output will appear here as it arrives."}
                    </p>
                  </div>
                </MessageScrollerItem>
              ) : (
                renderTranscriptMessageItems({ messages: session.messages })
              )}
              {queuedMessages.map((message) => (
                <MessageScrollerItem key={message.id} messageId={`queued:${message.id}`}>
                  <article className="transcript-entry transcript-user transcript-queued-message">
                    <header className="transcript-entry-header">
                      <span className="message-author">You</span>
                      <Badge className={message.status === "failed" ? "queued-message-failed" : undefined}>
                        {message.status === "failed" ? "Not sent" : "Queued"}
                      </Badge>
                      <time dateTime={message.createdAt}>{formatSessionTime(message.createdAt)}</time>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="queued-message-cancel"
                        aria-label="Cancel queued message"
                        title="Cancel queued message"
                        onClick={() => onCancelQueuedMessage(message.id)}
                      >
                        <DashboardIcon name="close" />
                      </Button>
                    </header>
                    <div className="transcript-message">{message.text}</div>
                    {message.error ? <p className="queued-message-error">{message.error}</p> : null}
                  </article>
                </MessageScrollerItem>
              ))}
              {session.status === "running" ? (
                <MessageScrollerItem messageId={`working:${session.id}`} hidden={Boolean(activeAskRequest)}>
                  {activeAskRequest ? null : (
                    <WorkingIndicator status={session.status} message={session.messages.at(-1)} />
                  )}
                </MessageScrollerItem>
              ) : null}
              {activeAskRequest ? (
                <MessageScrollerItem
                  key={`${activeAskRequest.sessionId}:${activeAskRequest.requestId}`}
                  messageId={`ask:${activeAskRequest.sessionId}:${activeAskRequest.requestId}`}
                >
                  <AskToolCall
                    request={activeAskRequest}
                    connection={connection}
                    onRespond={(response) => onRespondToAsk(activeAskRequest, response)}
                    onActivity={() => void onAskActivity(activeAskRequest)}
                  />
                </MessageScrollerItem>
              ) : null}
              {statusItem ? (
                <MessageScrollerItem
                  className="transcript-history-item"
                  messageId={`transcript-status:${session.id}`}
                >
                  {statusItem}
                </MessageScrollerItem>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            className="scroll-to-bottom-button"
            aria-label="Scroll to latest output"
            title="Scroll to latest output"
          >
            <DashboardIcon name="down" />
          </MessageScrollerButton>
        </MessageScroller>
        <MessageScrollerScrollController onScrollToEnd={onRegisterScrollToEnd} />
      </MessageScrollerProvider>
      {session.activeSubagents.length > 0 ? (
        <section className="subagent-activity" aria-label="Active subagents" aria-live="polite">
          <strong className="subagent-activity-heading">
            {formatSubagentActivityLabel(session.activeSubagents.length)}
          </strong>
          <ul className="subagent-list">
            {session.activeSubagents.slice(0, 5).map((subagent) => (
              <li key={subagent.id}>
                <button
                  type="button"
                  aria-label={`Open ${subagent.name} session`}
                  onClick={() => onViewSubagent(subagent)}
                >
                  <span>{subagent.name}</span>
                  <time dateTime={subagent.lastActivity}>{formatSessionTime(subagent.lastActivity)}</time>
                </button>
              </li>
            ))}
            {session.activeSubagents.length > 5 ? (
              <li className="subagent-overflow">
                <span>+{session.activeSubagents.length - 5} more</span>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export interface WorkingIndicatorProps {
  status: Session["status"];
  message?: Session["messages"][number] | null | undefined;
  label?: string | undefined;
}

export function formatWorkingLabel(message?: Session["messages"][number] | null | undefined): string {
  if (!message) return "Working";
  if (message.role === "tool" && (message.streaming || message.lifecycle?.state === "running")) {
    if (message.toolTitle) return message.toolTitle;
    if (message.toolName) {
      return message.toolName.charAt(0).toUpperCase() + message.toolName.slice(1);
    }
    return "Tool";
  }
  if (message.role === "assistant" && message.streaming) {
    return "Thinking...";
  }
  return "Working";
}

export function WorkingIndicator({ status, message, label }: WorkingIndicatorProps) {
  if (status !== "running") return null;

  const displayedLabel = label ?? formatWorkingLabel(message);

  return (
    <Badge className="working-indicator" role="status">
      <span className="working-indicator-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {displayedLabel}
    </Badge>
  );
}
