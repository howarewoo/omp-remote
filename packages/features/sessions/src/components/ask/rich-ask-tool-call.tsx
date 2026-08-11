import type { AskRequest, AskResponse } from "@omp-remote/protocol";
import { useState } from "react";
import { Button } from "../ui/button.js";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "../ui/questionnaire.js";
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
  noteVisible: boolean;
};

function questionnaireItemName(questionIndex: number) {
  return `ask-question-${questionIndex}`;
}

function questionnaireOptionValue(questionIndex: number, optionIndex: number) {
  return `ask-option-${questionIndex}-${optionIndex}`;
}

function questionnaireOtherValue(questionIndex: number) {
  return `ask-other-${questionIndex}`;
}

function selectedOptionLabels(
  question: RichAskRequest["questions"][number],
  questionIndex: number,
  selectedValues: readonly string[],
) {
  return selectedValues.flatMap((value) => {
    const optionIndex = question.options.findIndex(
      (_option, index) => questionnaireOptionValue(questionIndex, index) === value,
    );
    return optionIndex === -1 ? [] : [question.options[optionIndex]?.label ?? ""];
  });
}

function resizeAskTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  const styles = globalThis.getComputedStyle?.(textarea);
  const lineHeight = Number.parseFloat(styles?.lineHeight ?? "") || 24;
  const padding =
    (Number.parseFloat(styles?.paddingTop ?? "") || 0) +
    (Number.parseFloat(styles?.paddingBottom ?? "") || 0);
  const maxHeight = lineHeight * 6 + padding;
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, lineHeight + padding), maxHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

export function RichAskToolCall({ request, connection, onRespond, onActivity }: RichAskToolCallProps) {
  const [answers, setAnswers] = useState<RichAnswer[]>(() =>
    request.questions.map(() => ({ selectedOptions: [], customInput: "", note: "", noteVisible: false })),
  );
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const sending = state === "sending";
  const disabled = sending || connection !== "connected";
  const askId = `ask-answer-${encodeURIComponent(request.sessionId)}-${encodeURIComponent(request.requestId)}`;
  const questionCount = request.questions.length;
  const items = request.questions.map((question, questionIndex) => ({
    name: questionnaireItemName(questionIndex),
    required: true,
    choices: [
      ...question.options.map((_option, optionIndex) => ({
        value: questionnaireOptionValue(questionIndex, optionIndex),
      })),
      { value: questionnaireOtherValue(questionIndex) },
    ],
  }));

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

  const submit = () => {
    const valid = request.questions.every((question, index) => {
      const answer = answers[index];
      if (!answer) return false;
      const selectedOptions = selectedOptionLabels(question, index, answer.selectedOptions);
      return (
        selectedOptions.length > 0 ||
        (answer.selectedOptions.includes(questionnaireOtherValue(index)) &&
          Boolean(answer.customInput.trim()))
      );
    });
    if (!valid) return;
    void respond({
      kind: "submit",
      results: request.questions.map((question, index) => {
        const answer = answers[index] ?? {
          selectedOptions: [],
          customInput: "",
          note: "",
          noteVisible: false,
        };
        return {
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
          multi: question.multi ?? false,
          selectedOptions: selectedOptionLabels(question, index, answer.selectedOptions),
          ...(answer.customInput.trim() ? { customInput: answer.customInput } : {}),
          ...(answer.note.trim() ? { note: answer.note } : {}),
        };
      }),
    });
  };
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
      <Questionnaire
        aria-label={questionCount === 1 ? "Ask question" : "Ask questions"}
        className="ask-questionnaire"
        items={items}
        noValidate={false}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {questionCount > 1 ? <QuestionnaireProgress /> : null}
        {request.questions.map((question, questionIndex) => {
          const answer = answers[questionIndex] ?? {
            selectedOptions: [],
            customInput: "",
            note: "",
            noteVisible: false,
          };
          const otherValue = questionnaireOtherValue(questionIndex);
          const otherSelected = answer.selectedOptions.includes(otherValue);
          const customId = `${askId}-${questionIndex}-custom`;
          const noteId = `${askId}-${questionIndex}-note`;
          const invalidOther = otherSelected && !answer.customInput.trim();

          const toggleOption = (value: string, checked: boolean) => {
            onActivity();
            updateAnswer(questionIndex, (current) => {
              if (question.multi) {
                if (checked) {
                  return {
                    ...current,
                    selectedOptions: current.selectedOptions.includes(value)
                      ? current.selectedOptions
                      : [...current.selectedOptions, value],
                  };
                }
                return {
                  ...current,
                  selectedOptions: current.selectedOptions.filter((option) => option !== value),
                  ...(value === otherValue ? { customInput: "" } : {}),
                };
              }
              return {
                ...current,
                selectedOptions: [value],
                ...(value === otherValue ? {} : { customInput: "" }),
              };
            });
          };

          const updateTextarea = (
            field: "customInput" | "note",
            value: string,
            element: HTMLTextAreaElement,
          ) => {
            resizeAskTextarea(element);
            onActivity();
            updateAnswer(questionIndex, (current) => ({
              ...current,
              [field]: value,
              ...(field === "note" && value.trim() ? { noteVisible: true } : {}),
            }));
          };

          return (
            <QuestionnaireItem
              disabled={disabled}
              invalid={invalidOther}
              key={questionnaireItemName(questionIndex)}
              multiple={question.multi ?? false}
              name={questionnaireItemName(questionIndex)}
              required
            >
              <QuestionnaireTitle>
                {question.header ? (
                  <span className="ask-question-header">
                    {renderSafeHttpText(question.header, `ask-rich-header-${questionIndex}`)}
                  </span>
                ) : null}
                <span>{renderSafeHttpText(question.question, `ask-rich-question-${questionIndex}`)}</span>
              </QuestionnaireTitle>
              <QuestionnaireChoices>
                {question.options.map((option, optionIndex) => {
                  const optionKey = `${option.label}-${optionIndex}`;
                  const optionValue = questionnaireOptionValue(questionIndex, optionIndex);
                  const selected = answer.selectedOptions.includes(optionValue);
                  const optionHasLinks = askOptionHasLinks([
                    option.label,
                    option.description,
                    option.preview,
                  ]);
                  const choice = (
                    <QuestionnaireChoice
                      checked={selected}
                      disabled={disabled}
                      key={optionKey}
                      onChange={(event) => toggleOption(optionValue, event.target.checked)}
                      value={optionValue}
                    >
                      {renderAskOptionControlCopy({
                        ...(option.description === undefined ? {} : { description: option.description }),
                        keyPrefix: `ask-rich-questionnaire-option-${questionIndex}-${optionIndex}`,
                        label: option.label,
                        ...(option.preview === undefined ? {} : { preview: option.preview }),
                        recommended: question.recommended === optionIndex,
                      })}
                    </QuestionnaireChoice>
                  );
                  return optionHasLinks ? (
                    <div className="ask-option-row" key={optionKey}>
                      {choice}
                      {renderAskOptionLinkContainer(
                        [option.label, option.description, option.preview],
                        `ask-rich-questionnaire-option-${questionIndex}-${optionIndex}`,
                      )}
                    </div>
                  ) : (
                    choice
                  );
                })}
                <QuestionnaireChoice
                  checked={otherSelected}
                  disabled={disabled}
                  onChange={(event) => toggleOption(otherValue, event.target.checked)}
                  value={otherValue}
                >
                  <span className="ask-option-copy">
                    <span>Other</span>
                  </span>
                </QuestionnaireChoice>
                {otherSelected ? (
                  <label className="ask-questionnaire-input-label" htmlFor={customId}>
                    <span>Other answer</span>
                    <textarea
                      aria-invalid={invalidOther || undefined}
                      className="ui-textarea ask-textarea"
                      disabled={disabled}
                      id={customId}
                      onChange={(event) =>
                        updateTextarea("customInput", event.target.value, event.currentTarget)
                      }
                      required
                      rows={1}
                      value={answer.customInput}
                    />
                  </label>
                ) : null}
              </QuestionnaireChoices>
              <QuestionnaireError>
                {invalidOther ? "Enter an answer for Other to continue." : undefined}
              </QuestionnaireError>
              {answer.noteVisible ? (
                <label className="ask-questionnaire-note" htmlFor={noteId}>
                  <span className="ask-questionnaire-note-label">Note (optional)</span>
                  <textarea
                    aria-label="Note (optional)"
                    className="ui-textarea ask-textarea"
                    disabled={disabled}
                    id={noteId}
                    onChange={(event) => updateTextarea("note", event.target.value, event.currentTarget)}
                    rows={1}
                    value={answer.note}
                  />
                  <Button
                    className="ask-questionnaire-note-toggle"
                    disabled={disabled}
                    onClick={() => {
                      onActivity();
                      updateAnswer(questionIndex, (current) => ({
                        ...current,
                        note: "",
                        noteVisible: false,
                      }));
                    }}
                    type="button"
                    variant="ghost"
                  >
                    Remove note
                  </Button>
                </label>
              ) : (
                <Button
                  className="ask-questionnaire-note-toggle"
                  disabled={disabled}
                  onClick={() => {
                    onActivity();
                    updateAnswer(questionIndex, (current) => ({ ...current, noteVisible: true }));
                  }}
                  type="button"
                  variant="ghost"
                >
                  Add note
                </Button>
              )}
            </QuestionnaireItem>
          );
        })}
        <QuestionnaireActions>
          <Button
            disabled={sending || connection !== "connected"}
            onClick={() => void respond({ cancelled: true })}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            disabled={sending || connection !== "connected"}
            onClick={() => void respond({ kind: "chat" })}
            type="button"
            variant="outline"
          >
            Chat about this
          </Button>
          <QuestionnairePrevious disabled={disabled} />
          <QuestionnaireNext disabled={disabled} />
          <QuestionnaireSubmit disabled={disabled}>Submit answers</QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}
