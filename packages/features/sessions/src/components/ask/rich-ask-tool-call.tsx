import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { AskRequest, AskResponse } from "@omp-remote/protocol";
import { useLayoutEffect, useRef, useState } from "react";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Textarea } from "../ui/textarea.js";
import { cn } from "../ui/utils.js";
import { renderSafeHttpText } from "../transcript/inline-transcript.js";
import {
  askOptionHasLinks,
  renderAskOptionControlCopy,
  renderAskOptionLinkContainer,
} from "./ask-tool-call.js";

type RichAskRequest = Extract<AskRequest, { kind: "rich" }>;

type RichAskToolCallProps = {
  request: RichAskRequest;
  connection: "connecting" | "connected" | "disconnected";
  onRespond(response: AskResponse): Promise<void>;
  onActivity(): void;
};

type RichAnswer = {
  selectedOptions: string[];
  customInput: string;
  note: string;
};

export function RichAskToolCall({ request, connection, onRespond, onActivity }: RichAskToolCallProps) {
  const [answers, setAnswers] = useState<RichAnswer[]>(() =>
    request.questions.map(() => ({ selectedOptions: [], customInput: "", note: "" })),
  );
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const activeQuestionTitleRef = useRef<HTMLLegendElement | null>(null);
  const hasRenderedQuestion = useRef(false);
  const sending = state === "sending";
  const askId = `ask-answer-${encodeURIComponent(request.sessionId)}-${encodeURIComponent(request.requestId)}`;
  const questionCount = request.questions.length;
  const lastQuestionIndex = Math.max(questionCount - 1, 0);
  const boundedActiveQuestionIndex = Math.min(activeQuestionIndex, lastQuestionIndex);
  const activeQuestion = request.questions[boundedActiveQuestionIndex];
  const complete = request.questions.every(
    (_question, index) =>
      (answers[index]?.selectedOptions.length ?? 0) > 0 || Boolean(answers[index]?.customInput.trim()),
  );

  useLayoutEffect(() => {
    if (hasRenderedQuestion.current) {
      activeQuestionTitleRef.current?.focus();
    }
    hasRenderedQuestion.current = true;
  }, [request.requestId, boundedActiveQuestionIndex]);

  const updateAnswer = (index: number, update: (answer: RichAnswer) => RichAnswer) => {
    setAnswers((current) => {
      const answer = current[index];
      if (!answer) return current;
      const next = [...current];
      next[index] = update(answer);
      return next;
    });
  };

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

  const submit = () =>
    respond({
      kind: "submit",
      results: request.questions.map((question, index) => {
        const answer = answers[index] ?? { selectedOptions: [], customInput: "", note: "" };
        return {
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
          multi: question.multi ?? false,
          selectedOptions: answer.selectedOptions,
          ...(answer.customInput.trim() ? { customInput: answer.customInput } : {}),
          ...(answer.note.trim() ? { note: answer.note } : {}),
        };
      }),
    });

  return (
    <article
      className="transcript-entry transcript-tool transcript-ask ask-rich"
      aria-busy={sending}
      aria-labelledby={`${askId}-title`}
    >
      <header className="ask-header">
        <span className="message-author">
          <i aria-hidden="true">?</i>
          <span>ask</span>
        </span>
        <span className="ask-status" aria-live="polite">
          {sending ? "Sending response…" : "Waiting for your response"}
        </span>
      </header>
      <strong className="ask-title" id={`${askId}-title`}>
        {questionCount === 1 ? "One question" : `${questionCount} questions`}
      </strong>
      {questionCount > 1 ? (
        <span className="ask-progress" aria-live="polite">
          Question {boundedActiveQuestionIndex + 1} of {questionCount}
        </span>
      ) : null}
      <div className="ask-question-list">
        {activeQuestion ? (
          <fieldset className="ask-question" key={activeQuestion.id}>
            <legend
              className="ask-question-title"
              id={`${askId}-${boundedActiveQuestionIndex}-legend`}
              ref={activeQuestionTitleRef}
              tabIndex={-1}
            >
              {activeQuestion.header ? (
                <span className="ask-question-header">
                  {renderSafeHttpText(activeQuestion.header, "ask-rich-header")}
                </span>
              ) : null}
              <span>{renderSafeHttpText(activeQuestion.question, "ask-rich-question")}</span>
            </legend>
            {activeQuestion.multi ? (
              <div className="ask-options">
                {activeQuestion.options.map((option, optionIndex) => {
                  const answer = answers[boundedActiveQuestionIndex] ?? {
                    selectedOptions: [],
                    customInput: "",
                    note: "",
                  };
                  const selected = answer.selectedOptions.includes(option.label);
                  const toggleOption = () => {
                    onActivity();
                    updateAnswer(boundedActiveQuestionIndex, (current) => ({
                      ...current,
                      selectedOptions: selected
                        ? current.selectedOptions.filter((label) => label !== option.label)
                        : [...current.selectedOptions, option.label],
                    }));
                  };
                  const optionKey = `${option.label}-${optionIndex}`;
                  return askOptionHasLinks([option.label, option.description, option.preview]) ? (
                    <div className="ask-option-row" key={optionKey}>
                      <Button
                        aria-label={option.label}
                        aria-pressed={selected}
                        className="ask-option ask-rich-option"
                        disabled={sending || connection !== "connected"}
                        onClick={toggleOption}
                        type="button"
                        variant={selected ? "default" : "outline"}
                      >
                        {renderAskOptionControlCopy({
                          ...(option.description === undefined ? {} : { description: option.description }),
                          keyPrefix: `ask-rich-multi-option-${optionIndex}`,
                          label: option.label,
                          ...(option.preview === undefined ? {} : { preview: option.preview }),
                          recommended: activeQuestion.recommended === optionIndex,
                        })}
                      </Button>
                      {renderAskOptionLinkContainer(
                        [option.label, option.description, option.preview],
                        `ask-rich-multi-option-${optionIndex}`,
                      )}
                    </div>
                  ) : (
                    <Button
                      aria-pressed={selected}
                      className="ask-option ask-rich-option"
                      disabled={sending || connection !== "connected"}
                      key={optionKey}
                      onClick={toggleOption}
                      type="button"
                      variant={selected ? "default" : "outline"}
                    >
                      <span className="ask-option-copy">
                        <span>
                          {renderSafeHttpText(option.label, `ask-rich-multi-option-${optionIndex}:label`)}
                          {activeQuestion.recommended === optionIndex ? <Badge>Recommended</Badge> : null}
                        </span>
                        {option.description ? (
                          <span className="ask-option-description">
                            {renderSafeHttpText(
                              option.description,
                              `ask-rich-multi-option-${optionIndex}:description`,
                            )}
                          </span>
                        ) : null}
                        {option.preview ? (
                          <span className="ask-option-preview">
                            {renderSafeHttpText(
                              option.preview,
                              `ask-rich-multi-option-${optionIndex}:preview`,
                            )}
                          </span>
                        ) : null}
                      </span>
                    </Button>
                  );
                })}
              </div>
            ) : (
              <RadioGroup
                className="ask-options"
                aria-labelledby={`${askId}-${boundedActiveQuestionIndex}-legend`}
                name={`${askId}-${boundedActiveQuestionIndex}`}
                value={answers[boundedActiveQuestionIndex]?.selectedOptions[0] ?? ""}
                disabled={sending || connection !== "connected"}
                onValueChange={(value) => {
                  onActivity();
                  updateAnswer(boundedActiveQuestionIndex, (current) => ({
                    ...current,
                    selectedOptions: [value],
                    customInput: "",
                  }));
                }}
              >
                {activeQuestion.options.map((option, optionIndex) => {
                  const answer = answers[boundedActiveQuestionIndex] ?? {
                    selectedOptions: [],
                    customInput: "",
                    note: "",
                  };
                  const selected = answer.selectedOptions.includes(option.label);
                  const optionKey = `${option.label}-${optionIndex}`;
                  const optionHasLinks = askOptionHasLinks([
                    option.label,
                    option.description,
                    option.preview,
                  ]);
                  const radio = (
                    <Radio.Root
                      value={option.label}
                      render={
                        <button
                          aria-label={option.label}
                          type="button"
                          data-slot="button"
                          className={cn(
                            "ui-button",
                            selected ? "ui-button-default" : "ui-button-outline",
                            "ui-button-size-default",
                            "ask-option ask-rich-option",
                          )}
                        />
                      }
                      key={optionKey}
                    >
                      {renderAskOptionControlCopy({
                        ...(option.description === undefined ? {} : { description: option.description }),
                        keyPrefix: `ask-rich-radio-option-${optionIndex}`,
                        label: option.label,
                        ...(option.preview === undefined ? {} : { preview: option.preview }),
                        recommended: activeQuestion.recommended === optionIndex,
                      })}
                    </Radio.Root>
                  );
                  return optionHasLinks ? (
                    <div className="ask-option-row" key={optionKey}>
                      {radio}
                      {renderAskOptionLinkContainer(
                        [option.label, option.description, option.preview],
                        `ask-rich-radio-option-${optionIndex}`,
                      )}
                    </div>
                  ) : (
                    radio
                  );
                })}
              </RadioGroup>
            )}
            <label htmlFor={`${askId}-${boundedActiveQuestionIndex}-custom`}>Custom answer</label>
            <Textarea
              id={`${askId}-${boundedActiveQuestionIndex}-custom`}
              className="ask-textarea"
              value={answers[boundedActiveQuestionIndex]?.customInput ?? ""}
              onChange={(event) => {
                onActivity();
                updateAnswer(boundedActiveQuestionIndex, (current) => ({
                  ...current,
                  selectedOptions: activeQuestion.multi ? current.selectedOptions : [],
                  customInput: event.target.value,
                }));
              }}
              disabled={sending || connection !== "connected"}
              rows={2}
            />
            <label htmlFor={`${askId}-${boundedActiveQuestionIndex}-note`}>Note (optional)</label>
            <Textarea
              id={`${askId}-${boundedActiveQuestionIndex}-note`}
              className="ask-textarea"
              value={answers[boundedActiveQuestionIndex]?.note ?? ""}
              onChange={(event) => {
                onActivity();
                updateAnswer(boundedActiveQuestionIndex, (current) => ({
                  ...current,
                  note: event.target.value,
                }));
              }}
              disabled={sending || connection !== "connected"}
              rows={2}
            />
          </fieldset>
        ) : null}
      </div>
      <footer className="ask-actions ask-rich-actions">
        <Button
          type="button"
          variant="ghost"
          disabled={sending || connection !== "connected"}
          onClick={() => void respond({ cancelled: true })}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={sending || connection !== "connected"}
          onClick={() => void respond({ kind: "chat" })}
        >
          Chat about this
        </Button>
        {questionCount > 1 ? (
          <Button
            type="button"
            variant="outline"
            disabled={boundedActiveQuestionIndex === 0 || sending || connection !== "connected"}
            onClick={() => setActiveQuestionIndex((current) => Math.max(current - 1, 0))}
          >
            Previous
          </Button>
        ) : null}
        {boundedActiveQuestionIndex < lastQuestionIndex ? (
          <Button
            type="button"
            disabled={sending || connection !== "connected"}
            onClick={() => setActiveQuestionIndex((current) => Math.min(current + 1, lastQuestionIndex))}
          >
            Next
          </Button>
        ) : (
          <Button
            type="button"
            disabled={sending || connection !== "connected" || !complete}
            onClick={() => void submit()}
          >
            Submit answers
          </Button>
        )}
      </footer>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}
