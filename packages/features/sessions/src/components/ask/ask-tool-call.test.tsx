import {
  SELECT_ASK,
  findElements,
  getReactHarness,
  textContent,
} from "../dashboard/dashboard-test-support.js";
import {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnaireProgress,
} from "../ui/questionnaire.js";
import type { AskRequest } from "@omp-remote/protocol";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AskToolCall } from "../dashboard.js";
const reactHarness = getReactHarness();

function renderAskToolCall(
  request: AskRequest,
  overrides: Partial<Parameters<typeof AskToolCall>[0]> = {},
  preserveState = false,
): ReactNode {
  if (!preserveState) {
    reactHarness.refValues = [];
    reactHarness.stateValues = [];
  }
  reactHarness.refIndex = 0;
  reactHarness.stateIndex = 0;
  const element = AskToolCall({
    request,
    connection: "connected",
    onRespond: vi.fn().mockResolvedValue(undefined),
    onActivity: vi.fn(),
    ...overrides,
  });
  if (!isValidElement(element) || typeof element.type !== "function") return element;
  return (element.type as (props: typeof element.props) => ReactNode)(element.props);
}

const TEXT_ASK: AskRequest = {
  sessionId: "session-1",
  requestId: "ask-text",
  kind: "text",
  title: "Describe the release",
  options: [],
  initialValue: "Initial context",
  expiresAt: null,
};

const RICH_ASK: AskRequest = {
  sessionId: "session-1",
  requestId: "ask-rich",
  kind: "rich",
  questions: [
    {
      id: "database",
      question: "Which database?",
      header: "Storage",
      options: [
        { label: "SQLite", description: "Embedded", preview: "file:local.db" },
        { label: "PostgreSQL", description: "Server", preview: "postgres://…" },
      ],
      multi: true,
      recommended: 1,
    },
  ],
  expiresAt: null,
};

const MULTIPLE_RICH_ASK: AskRequest = {
  sessionId: "session-1",
  requestId: "ask-multiple-rich",
  kind: "rich",
  questions: [
    {
      id: "target",
      question: "Which deployment target?",
      header: "Deployment",
      options: [
        { label: "Preview", description: "Private validation", preview: "preview.example.test" },
        { label: "Production", description: "Public release" },
      ],
      multi: false,
      recommended: 0,
    },
    {
      id: "checks",
      question: "Which checks should run?",
      options: [{ label: "Smoke tests" }, { label: "Full suite" }],
      multi: true,
    },
  ],
  expiresAt: null,
};

const SINGLE_RICH_ASK: AskRequest = {
  ...MULTIPLE_RICH_ASK,
  requestId: "ask-single-rich",
  questions: MULTIPLE_RICH_ASK.questions.slice(0, 1),
};

describe("AskToolCall", () => {
  it("keeps Ask links outside native controls while preserving option activation", () => {
    const onActivity = vi.fn();
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const legacy = renderAskToolCall(
      {
        ...SELECT_ASK,
        title: "Review https://omp.sh/ask",
        options: ["Open https://omp.sh/docs"],
      },
      { onActivity, onRespond },
    );
    const legacyOptionLinks = findElements(
      legacy,
      (element) => element.props.className === "ask-option-links",
    )[0];
    const legacyLink = findElements(legacyOptionLinks, (element) => element.type === "a")[0];
    const legacyButton = findElements(legacy, (element) => element.props.className === "ask-option")[0];
    expect(legacyLink?.props.href).toBe("https://omp.sh/docs");
    expect(findElements(legacyButton, (element) => element.type === "a")).toHaveLength(0);
    const stopPropagation = vi.fn();
    (legacyLink?.props.onClick as ((event: { stopPropagation(): void }) => void) | undefined)?.({
      stopPropagation,
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onRespond).not.toHaveBeenCalled();
    (legacyButton?.props.onClick as (() => void) | undefined)?.();

    const richQuestion = RICH_ASK.questions[0];
    if (!richQuestion) throw new Error("Expected rich question fixture");
    const richMultiRequest: AskRequest = {
      ...RICH_ASK,
      questions: [
        {
          ...richQuestion,
          options: [{ label: "Open https://omp.sh/multi", description: "Docs https://omp.sh/info" }],
        },
      ],
    };
    const richMulti = renderAskToolCall(richMultiRequest, { onActivity, onRespond });
    const multiOptionLinks = findElements(
      richMulti,
      (element) => element.props.className === "ask-option-links",
    )[0];
    const multiLink = findElements(multiOptionLinks, (element) => element.type === "a")[0];
    const multiChoice = findElements(
      richMulti,
      (element) => element.type === QuestionnaireChoice && element.props.value === "ask-option-0-0",
    )[0];
    expect(multiLink?.props.href).toBe("https://omp.sh/multi");
    expect(findElements(multiChoice, (element) => element.type === "a")).toHaveLength(0);
    (multiChoice?.props.onChange as ((event: { target: { checked: boolean } }) => void) | undefined)?.({
      target: { checked: true },
    });
    const richMultiSelected = renderAskToolCall(richMultiRequest, { onActivity, onRespond }, true);
    expect(
      findElements(
        richMultiSelected,
        (element) => element.type === QuestionnaireChoice && element.props.checked === true,
      ),
    ).toHaveLength(1);

    const radioQuestion = MULTIPLE_RICH_ASK.questions[0];
    if (!radioQuestion) throw new Error("Expected radio question fixture");
    const richRadioRequest: AskRequest = {
      ...MULTIPLE_RICH_ASK,
      questions: [
        {
          ...radioQuestion,
          options: [{ label: "Open https://omp.sh/radio", preview: "More https://omp.sh/preview" }],
          multi: false,
        },
      ],
    };
    const richRadio = renderAskToolCall(richRadioRequest, { onActivity, onRespond });
    const radioOptionLinks = findElements(
      richRadio,
      (element) => element.props.className === "ask-option-links",
    )[0];
    const radioLink = findElements(radioOptionLinks, (element) => element.type === "a")[0];
    const radio = findElements(
      richRadio,
      (element) => element.type === QuestionnaireChoice && element.props.value === "ask-option-0-0",
    )[0];
    expect(radioLink?.props.href).toBe("https://omp.sh/radio");
    expect(findElements(radio, (element) => element.type === "a")).toHaveLength(0);
    const radioStopPropagation = vi.fn();
    (radioLink?.props.onClick as ((event: { stopPropagation(): void }) => void) | undefined)?.({
      stopPropagation: radioStopPropagation,
    });
    expect(radioStopPropagation).toHaveBeenCalledOnce();
    expect(onActivity).toHaveBeenCalled();
  });

  it("renders transcript-native select controls and sends the selected value", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const output = renderAskToolCall(SELECT_ASK, { onRespond });
    const article = findElements(output, (element) => element.type === "article")[0];
    const preview = findElements(output, (element) => element.props.className === "ask-option")[0];

    expect(article?.props.className).toBe("transcript-entry transcript-tool transcript-ask");
    expect(textContent(output)).toContain("Choose a deployment target");
    expect(preview?.props.disabled).toBe(false);

    (preview?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onRespond).toHaveBeenCalledWith({ value: "Preview" });
  });

  it("renders and submits every rich ask answer field", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    let output = renderAskToolCall(RICH_ASK, { onRespond });
    expect(textContent(output)).toContain("Storage");
    expect(textContent(output)).toContain("Embedded");
    expect(textContent(output)).toContain("file:local.db");
    expect(textContent(output)).toContain("Recommended");

    const options = findElements(
      output,
      (element) => element.type === QuestionnaireChoice && element.props.value !== "ask-other-0",
    );
    expect(options[0]?.props.checked).toBe(false);
    (options[1]?.props.onChange as ((event: { target: { checked: boolean } }) => void) | undefined)?.({
      target: { checked: true },
    });
    const other = findElements(
      output,
      (element) => element.type === QuestionnaireChoice && element.props.value === "ask-other-0",
    )[0];
    (other?.props.onChange as ((event: { target: { checked: boolean } }) => void) | undefined)?.({
      target: { checked: true },
    });
    output = renderAskToolCall(RICH_ASK, { onRespond }, true);

    const custom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-rich-0-custom",
    )[0];
    expect(custom).toBeDefined();
    (
      custom?.props.onChange as
        | ((event: { target: { value: string }; currentTarget: HTMLTextAreaElement }) => void)
        | undefined
    )?.({
      target: { value: "CockroachDB" },
      currentTarget: { style: {}, scrollHeight: 24 } as HTMLTextAreaElement,
    });
    const addNote = findElements(output, (element) => textContent(element) === "Add note")[0];
    (addNote?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(RICH_ASK, { onRespond }, true);
    const note = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-rich-0-note",
    )[0];
    (
      note?.props.onChange as
        | ((event: { target: { value: string }; currentTarget: HTMLTextAreaElement }) => void)
        | undefined
    )?.({
      target: { value: "Needs horizontal scaling" },
      currentTarget: { style: {}, scrollHeight: 24 } as HTMLTextAreaElement,
    });
    output = renderAskToolCall(RICH_ASK, { onRespond }, true);
    const root = findElements(output, (element) => element.type === Questionnaire)[0];
    const submit = root?.props.onSubmit as ((event: { preventDefault(): void }) => void) | undefined;
    expect(submit).toBeDefined();
    (submit as ((event: { preventDefault(): void }) => void) | undefined)?.({ preventDefault: vi.fn() });
    await Promise.resolve();

    expect(onRespond).toHaveBeenCalledWith({
      kind: "submit",
      results: [
        {
          id: "database",
          question: "Which database?",
          options: ["SQLite", "PostgreSQL"],
          multi: true,
          selectedOptions: ["PostgreSQL"],
          customInput: "CockroachDB",
          note: "Needs horizontal scaling",
        },
      ],
    });
  });

  it("delegates progress, choices, validation, and actions to Questionnaire", () => {
    const output = renderAskToolCall(MULTIPLE_RICH_ASK);
    const root = findElements(output, (element) => element.type === Questionnaire)[0];
    expect(root?.props.items).toEqual([
      {
        name: "ask-question-0",
        required: true,
        choices: [{ value: "ask-option-0-0" }, { value: "ask-option-0-1" }, { value: "ask-other-0" }],
      },
      {
        name: "ask-question-1",
        required: true,
        choices: [{ value: "ask-option-1-0" }, { value: "ask-option-1-1" }, { value: "ask-other-1" }],
      },
    ]);
    expect(findElements(output, (element) => element.type === QuestionnaireItem)).toHaveLength(2);
    expect(findElements(output, (element) => element.type === QuestionnaireChoices)).toHaveLength(2);
    expect(findElements(output, (element) => element.type === QuestionnaireChoice)).toHaveLength(6);
    expect(findElements(output, (element) => element.type === QuestionnaireProgress)).toHaveLength(1);
    expect(findElements(output, (element) => element.type === QuestionnaireNext)).toHaveLength(1);
  });

  it("keeps controls disabled while disconnected", () => {
    const output = renderAskToolCall(MULTIPLE_RICH_ASK, { connection: "disconnected" });
    expect(
      findElements(
        output,
        (element) => element.type === QuestionnaireChoice && element.props.disabled === true,
      ),
    ).toHaveLength(6);
    expect(findElements(output, (element) => element.type === QuestionnaireNext)[0]?.props.disabled).toBe(
      true,
    );
  });
  it("keeps single-select choices and Other answers mutually exclusive", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const onActivity = vi.fn();
    let output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity });
    expect(findElements(output, (element) => element.type === QuestionnaireProgress)).toHaveLength(0);
    const preview = findElements(
      output,
      (element) => element.type === QuestionnaireChoice && element.props.value === "ask-option-0-0",
    )[0];
    (preview?.props.onChange as ((event: { target: { checked: boolean } }) => void) | undefined)?.({
      target: { checked: true },
    });
    output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity }, true);
    expect(
      findElements(
        output,
        (element) => element.type === QuestionnaireChoice && element.props.checked === true,
      ),
    ).toHaveLength(1);
    const other = findElements(
      output,
      (element) => element.type === QuestionnaireChoice && element.props.value === "ask-other-0",
    )[0];
    (other?.props.onChange as ((event: { target: { checked: boolean } }) => void) | undefined)?.({
      target: { checked: true },
    });
    output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity }, true);
    expect(
      findElements(
        output,
        (element) => typeof element.props.id === "string" && element.props.id.endsWith("-custom"),
      ),
    ).toHaveLength(1);
    const root = findElements(output, (element) => element.type === Questionnaire)[0];
    (root?.props.onSubmit as ((event: { preventDefault(): void }) => void) | undefined)?.({
      preventDefault: vi.fn(),
    });
    await Promise.resolve();
    expect(onRespond).not.toHaveBeenCalled();
  });
  it("keeps protocol labels and duplicate question ids distinct from Questionnaire values", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const request: AskRequest = {
      ...SINGLE_RICH_ASK,
      requestId: "ask-collision",
      questions: [
        {
          id: "duplicate",
          question: "First duplicate",
          options: [{ label: "__ask_other__" }],
          multi: false,
        },
        {
          id: "duplicate",
          question: "Second duplicate",
          options: [{ label: "Second" }],
          multi: false,
        },
      ],
    };
    let output = renderAskToolCall(request, { onRespond });
    for (const value of ["ask-option-0-0", "ask-option-1-0"]) {
      const choice = findElements(
        output,
        (element) => element.type === QuestionnaireChoice && element.props.value === value,
      )[0];
      (choice?.props.onChange as ((event: { target: { checked: boolean } }) => void) | undefined)?.({
        target: { checked: true },
      });
      output = renderAskToolCall(request, { onRespond }, true);
    }
    const root = findElements(output, (element) => element.type === Questionnaire)[0];
    (root?.props.onSubmit as ((event: { preventDefault(): void }) => void) | undefined)?.({
      preventDefault: vi.fn(),
    });
    await Promise.resolve();
    expect(onRespond).toHaveBeenCalledWith({
      kind: "submit",
      results: [
        {
          id: "duplicate",
          question: "First duplicate",
          options: ["__ask_other__"],
          multi: false,
          selectedOptions: ["__ask_other__"],
        },
        {
          id: "duplicate",
          question: "Second duplicate",
          options: ["Second"],
          multi: false,
          selectedOptions: ["Second"],
        },
      ],
    });
  });

  it.each([
    ["Chat about this", { kind: "chat" }],
    ["Cancel", { cancelled: true }],
  ])("supports rich ask %s", async (label, response) => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const output = renderAskToolCall(RICH_ASK, { onRespond });
    const action = findElements(
      output,
      (element) => typeof element.props.onClick === "function" && textContent(element) === label,
    )[0];
    (action?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    expect(onRespond).toHaveBeenCalledWith(response);
  });

  it("keeps text input labelled, does not autofocus it, and submits the current draft", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const textRequest = { ...TEXT_ASK, sessionId: "session one", requestId: "ask / text" };
    let output = renderAskToolCall(textRequest, { onRespond });
    let textarea = findElements(output, (element) => element.props.className === "ask-textarea")[0];

    expect(textarea?.props.value).toBe("Initial context");
    expect(textarea?.props.autoFocus).toBeUndefined();
    expect(findElements(output, (element) => element.type === "label")[0]?.props.htmlFor).toBe(
      textarea?.props.id,
    );
    expect(textarea?.props.id).toBe("ask-answer-session%20one-ask%20%2F%20text");

    (textarea?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Release after smoke checks" },
    });
    output = renderAskToolCall(textRequest, { onRespond }, true);
    textarea = findElements(output, (element) => element.props.className === "ask-textarea")[0];
    const form = findElements(output, (element) => element.type === "form")[0];
    const preventDefault = vi.fn();
    (form?.props.onSubmit as ((event: { preventDefault(): void }) => void) | undefined)?.({
      preventDefault,
    });
    await Promise.resolve();

    expect(textarea?.props.value).toBe("Release after smoke checks");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onRespond).toHaveBeenCalledWith({ value: "Release after smoke checks" });
  });
  it("sends cancellation and restores composer focus only after success", async () => {
    const focus = vi.fn();
    const querySelector = vi.fn().mockReturnValue({ focus });
    vi.stubGlobal("document", { querySelector });
    try {
      const onRespond = vi.fn().mockResolvedValue(undefined);
      const output = renderAskToolCall(SELECT_ASK, { onRespond });
      const cancel = findElements(
        output,
        (element) => typeof element.props.onClick === "function" && textContent(element) === "Cancel",
      )[0];

      (cancel?.props.onClick as (() => void) | undefined)?.();
      await Promise.resolve();

      expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
      expect(querySelector).toHaveBeenCalledWith("#composer-message");
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("disables all actions while pending and leaves cancel available when disconnected", () => {
    const pending = new Promise<void>(() => {});
    const onRespond = vi.fn().mockReturnValue(pending);
    let output = renderAskToolCall(SELECT_ASK, { onRespond });
    expect(textContent(findElements(output, (element) => element.props.className === "ask-status")[0])).toBe(
      "Waiting for your response",
    );
    const preview = findElements(output, (element) => element.props.className === "ask-option")[0];
    (preview?.props.onClick as (() => void) | undefined)?.();

    output = renderAskToolCall(SELECT_ASK, { onRespond }, true);
    expect(findElements(output, (element) => element.type === "article")[0]?.props["aria-busy"]).toBe(true);
    expect(textContent(findElements(output, (element) => element.props.className === "ask-status")[0])).toBe(
      "Sending response…",
    );
    expect(
      findElements(output, (element) => element.props.className === "ask-option").every(
        (element) => element.props.disabled === true,
      ),
    ).toBe(true);
    expect(
      findElements(
        output,
        (element) => typeof element.props.onClick === "function" && textContent(element) === "Cancel",
      )[0]?.props.disabled,
    ).toBe(true);

    output = renderAskToolCall(SELECT_ASK, { connection: "disconnected" });
    expect(
      findElements(output, (element) => element.props.className === "ask-option")[0]?.props.disabled,
    ).toBe(true);
    expect(
      findElements(
        output,
        (element) => typeof element.props.onClick === "function" && textContent(element) === "Cancel",
      )[0]?.props.disabled,
    ).toBe(false);
  });

  it("shows a delivery error, re-enables controls, and does not steal focus", async () => {
    const querySelector = vi.fn();
    vi.stubGlobal("document", { querySelector });
    try {
      const onRespond = vi.fn().mockRejectedValue(new Error("Host connection dropped"));
      let output = renderAskToolCall(SELECT_ASK, { onRespond });
      const preview = findElements(output, (element) => element.props.className === "ask-option")[0];
      (preview?.props.onClick as (() => void) | undefined)?.();
      await Promise.resolve();
      await Promise.resolve();

      output = renderAskToolCall(SELECT_ASK, { onRespond }, true);
      const alert = findElements(output, (element) => element.props.role === "alert")[0];
      expect(textContent(alert)).toBe("Host connection dropped");
      expect(
        findElements(output, (element) => element.props.className === "ask-option")[0]?.props.disabled,
      ).toBe(false);
      expect(querySelector).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
