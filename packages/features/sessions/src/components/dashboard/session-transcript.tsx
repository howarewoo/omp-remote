import { type ActiveSubagent, type AskRequest, type AskResponse, type Session } from "@omp-remote/protocol";
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
import { Badge } from "../ui/badge.js";
import {
  MessageScrollerScrollController,
  renderTranscriptMessageItems,
} from "../transcript/transcript-entry.js";
import { DashboardIcon } from "./session-header.js";
import { formatSessionTime } from "./session-sidebar.js";

export interface SessionTranscriptProps {
  session: Session;
  transcriptLoading: boolean;
  activeAskRequest: AskRequest | null;
  connection: "connecting" | "connected" | "disconnected";
  onRespondToAsk(request: AskRequest, response: AskResponse): Promise<void>;
  onAskActivity(request: AskRequest): Promise<void>;
  onViewSubagent(subagent: ActiveSubagent): void;
  onRegisterScrollToEnd(handler: (() => void) | null): void;
}

export function SessionTranscript({
  session,
  transcriptLoading,
  activeAskRequest,
  connection,
  onRespondToAsk,
  onAskActivity,
  onViewSubagent,
  onRegisterScrollToEnd,
}: SessionTranscriptProps) {
  return (
    <>
      <MessageScrollerProvider
        key={session.id}
        autoScroll
        defaultScrollPosition="end"
        scrollEdgeThreshold={80}
      >
        <MessageScroller className="transcript-region">
          <MessageScrollerViewport className="transcript" aria-label="Session transcript">
            <MessageScrollerContent
              className="transcript-messages"
              role="log"
              aria-live="polite"
              aria-busy={session.messages.at(-1)?.streaming === true}
            >
              {transcriptLoading ? (
                <MessageScrollerItem messageId={`transcript-loading:${session.id}`}>
                  <div className="empty-transcript" role="status">
                    <span className="status-orbit" aria-hidden="true" />
                    <strong>Reading session transcript</strong>
                    <p>Large transcripts stay on the host and load only when selected.</p>
                  </div>
                </MessageScrollerItem>
              ) : session.messages.length === 0 && !activeAskRequest ? (
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
                renderTranscriptMessageItems({
                  messages: session.messages,
                  context: {
                    sessionStatus: session.status,
                    activeAskRequest,
                  },
                })
              )}
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
              {session.status === "running" ? (
                <MessageScrollerItem messageId={`working:${session.id}`}>
                  <WorkingIndicator status={session.status} />
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

export function WorkingIndicator({ status }: { status: Session["status"] }) {
  if (status !== "running") return null;

  return (
    <Badge className="working-indicator" role="status">
      <span className="working-indicator-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      Working
    </Badge>
  );
}
