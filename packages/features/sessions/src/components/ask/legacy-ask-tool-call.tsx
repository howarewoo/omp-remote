import type { AskRequest, AskResponse } from "@omp-remote/protocol";
import { useState } from "react";
import { Button } from "../ui/button.js";
import { Textarea } from "../ui/textarea.js";
import { renderSafeHttpText } from "../transcript/inline-transcript.js";
import {
  askOptionHasLinks,
  renderAskOptionControlCopy,
  renderAskOptionLinkContainer,
} from "./ask-tool-call.js";

type LegacyAskRequest = Extract<AskRequest, { kind: "select" | "text" }>;

type LegacyAskToolCallProps = {
  request: LegacyAskRequest;
  connection: "connecting" | "connected" | "disconnected";
  onRespond(response: AskResponse): Promise<void>;
};

export function LegacyAskToolCall({ request, connection, onRespond }: LegacyAskToolCallProps) {
  const [draft, setDraft] = useState(request.initialValue ?? "");
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const sending = state === "sending";
  const answerId = `ask-answer-${encodeURIComponent(request.sessionId)}-${encodeURIComponent(
    request.requestId,
  )}`;

  const respond = async (response: AskResponse) => {
    if (sending) return;
    setState("sending");
    setError(null);
    try {
      await onRespond(response);
      globalThis.document?.querySelector<HTMLElement>("#composer-message")?.focus();
    } catch (responseFailure) {
      setError(
        responseFailure instanceof Error ? responseFailure.message : "Your answer could not be delivered",
      );
      setState("idle");
    }
  };

  return (
    <article
      className="transcript-entry transcript-tool transcript-ask"
      aria-busy={sending}
      aria-labelledby={`${answerId}-title`}
    >
      <header className="ask-header">
        <span className="message-author">
          <i aria-hidden="true">?</i>
          <span>ask</span>
        </span>
        <span className="ask-status">{sending ? "Sending response…" : "Waiting for your response"}</span>
      </header>
      <strong className="ask-title" id={`${answerId}-title`}>
        {renderSafeHttpText(request.title, "ask-legacy-title")}
      </strong>
      {request.kind === "select" ? (
        <>
          <div className="ask-options">
            {request.options.map((option, index) => {
              const optionKey = `${option}-${index}`;
              const respondToOption = () => void respond({ value: option });
              return askOptionHasLinks([option]) ? (
                <div className="ask-option-row" key={optionKey}>
                  <Button
                    aria-label={option}
                    className="ask-option"
                    disabled={sending || connection !== "connected"}
                    onClick={respondToOption}
                    type="button"
                    variant="outline"
                  >
                    {renderAskOptionControlCopy({
                      keyPrefix: `ask-legacy-option-${index}`,
                      label: option,
                    })}
                  </Button>
                  {renderAskOptionLinkContainer([option], `ask-legacy-option-${index}`)}
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="ask-option"
                  disabled={sending || connection !== "connected"}
                  onClick={respondToOption}
                  key={optionKey}
                >
                  {renderSafeHttpText(option, `ask-legacy-option-${index}`)}
                </Button>
              );
            })}
          </div>
          <footer className="ask-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={sending}
              onClick={() => void respond({ cancelled: true })}
            >
              Cancel
            </Button>
          </footer>
        </>
      ) : (
        <form
          className="ask-answer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void respond({ value: draft });
          }}
        >
          <label htmlFor={answerId}>Your answer</label>
          <Textarea
            id={answerId}
            className="ask-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={sending || connection !== "connected"}
            rows={5}
          />
          <footer className="ask-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={sending}
              onClick={() => void respond({ cancelled: true })}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={sending || connection !== "connected"} aria-busy={sending}>
              {sending ? "Answering…" : "Answer"}
            </Button>
          </footer>
        </form>
      )}
      {error ? (
        <p className="inline-error ask-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}
