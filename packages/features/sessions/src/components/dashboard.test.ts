import {
  BASE_SESSION,
  SELECT_ASK,
  composerDashboardProps,
  findElements,
  getReactHarness,
  renderControlledDashboard,
  textContent,
} from "./dashboard/dashboard-test-support.js";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { AskRequest, Session } from "@omp-remote/protocol";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AskToolCall, MessageScrollerScrollController } from "./dashboard.js";
import { formatUsd, getSessionCostRows } from "./session-cost.js";
import { SessionCostMetadata, SessionCostViewer } from "./session-cost-viewer.js";
const reactHarness = getReactHarness();

describe("formatUsd", () => {
  it.each([
    [0, "$0.00"],
    [-0, "$0.00"],
    [2.5, "$2.50"],
    [0.0042, "$0.0042"],
    [0.00001, "$0.00001"],
    [-0.00001, "-$0.00001"],
    [0.00999, "$0.01"],
    [1.005, "$1.01"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatUsd(value)).toBe(expected);
  });
});

describe("session cost hierarchy", () => {
  const summary: NonNullable<Session["costSummary"]> = {
    totalUsd: 2.1,
    partial: true,
    agents: [
      { sessionId: "child", name: "Child", parentSessionId: "root", totalUsd: 0.004, available: true },
      {
        sessionId: "grandchild",
        name: "Grandchild",
        parentSessionId: "child",
        totalUsd: 0.2,
        available: false,
      },
      { sessionId: "root", name: "Root", parentSessionId: null, totalUsd: 1.9, available: true },
    ],
  };

  it("puts the selected main agent first and indents descendants by their chain", () => {
    expect(getSessionCostRows(summary, "root").map(({ agent, depth }) => [agent.name, depth])).toEqual([
      ["Root", 0],
      ["Child", 1],
      ["Grandchild", 2],
    ]);
  });
});

describe("dashboard session cost", () => {
  const costSummary: NonNullable<Session["costSummary"]> = {
    totalUsd: 1.25,
    partial: true,
    agents: [
      { sessionId: "session-1", name: "Bootstrap", parentSessionId: null, totalUsd: 1.2, available: true },
      { sessionId: "child", name: "Child", parentSessionId: "session-1", totalUsd: 0.05, available: false },
    ],
  };

  it("opens from metadata, rerenders live updates, and resets on selection change", () => {
    const second = { ...BASE_SESSION, id: "session-2", name: "Second" };
    let props = {
      ...composerDashboardProps({ ...BASE_SESSION, costSummary }),
      sessions: [{ ...BASE_SESSION, costSummary }, second],
    };
    let output = renderControlledDashboard(props);
    const metadata = findElements(output, (element) => element.type === SessionCostMetadata)[0] as
      | ReactElement<{ summary: Session["costSummary"]; onOpen(): void }>
      | undefined;
    const metadataButton = metadata ? SessionCostMetadata(metadata.props) : null;
    expect(metadataButton?.props.children).toBe("$1.25 · Partial");
    expect(metadataButton?.props["aria-label"]).toContain("Partial");
    metadata?.props.onOpen();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const viewer = findElements(output, (element) => element.type === SessionCostViewer)[0] as
      | ReactElement<{ open: boolean; session: Session | null }>
      | undefined;
    expect(viewer?.props.open).toBe(true);
    expect(viewer?.props.session?.costSummary?.totalUsd).toBe(1.25);

    props = {
      ...props,
      sessions: [{ ...BASE_SESSION, costSummary: { ...costSummary, totalUsd: 2.5 } }, second],
    };
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const updatedViewer = findElements(output, (element) => element.type === SessionCostViewer)[0] as
      | ReactElement<{ open: boolean; session: Session | null }>
      | undefined;
    expect(updatedViewer?.props.session?.costSummary?.totalUsd).toBe(2.5);

    props = { ...props, selectedSessionId: second.id };
    output = renderControlledDashboard(props, { preserveState: true });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const resetViewer = findElements(output, (element) => element.type === SessionCostViewer)[0] as
      | ReactElement<{ open: boolean; session: Session | null }>
      | undefined;
    expect(resetViewer?.props.open).toBe(false);
  });

  it("renders history sessions through the same viewer with unavailable rows", () => {
    const history = {
      ...BASE_SESSION,
      source: "history" as const,
      status: "history" as const,
      connected: false,
      costSummary: undefined,
    };
    const output = renderControlledDashboard(composerDashboardProps(history));
    const viewer = findElements(output, (element) => element.type === SessionCostViewer)[0] as
      | ReactElement<{ session: Session | null }>
      | undefined;
    expect(viewer?.props.session?.source).toBe("history");
    const rendered = SessionCostViewer({
      session: history,
      mobile: false,
      open: true,
      onOpenChange: vi.fn(),
    });
    expect(textContent(rendered.props.children)).toContain("Session cost");
  });
});

function findComposerTextarea(output: ReactNode): ReactElement<Record<string, unknown>> {
  const textarea = findElements(output, (element) => element.props.id === "composer-message")[0];
  if (!textarea) throw new Error("Expected dashboard composer textarea");
  return textarea;
}

function pressComposerKey(
  textarea: ReactElement<Record<string, unknown>>,
  key: string,
  shiftKey = false,
  isComposing = false,
) {
  const preventDefault = vi.fn();
  const requestSubmit = vi.fn();
  (
    textarea.props.onKeyDown as (event: {
      key: string;
      shiftKey: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      nativeEvent: { isComposing: boolean };
      preventDefault(): void;
      currentTarget: { form: { requestSubmit(): void } };
    }) => void
  )({
    key,
    shiftKey,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    nativeEvent: { isComposing },
    preventDefault,
    currentTarget: { form: { requestSubmit } },
  });
  return { preventDefault, requestSubmit };
}

describe("dashboard composer keyboard", () => {
  it("requests form submission and prevents a native newline on plain Enter", () => {
    const output = renderControlledDashboard(composerDashboardProps());
    const { preventDefault, requestSubmit } = pressComposerKey(findComposerTextarea(output), "Enter");

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  it("scrolls the transcript to the end after a message is submitted", async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const props = { ...composerDashboardProps(), onCommand };
    let output = renderControlledDashboard(props);

    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Show the latest output" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const scrollToEnd = vi.fn();
    const controller = findElements(output, (element) => element.type === MessageScrollerScrollController)[0];
    (controller?.props.onScrollToEnd as ((handler: () => void) => void) | undefined)?.(scrollToEnd);
    const form = findElements(output, (element) => element.props.className === "composer")[0];
    await (form?.props.onSubmit as ((event: { preventDefault(): void }) => Promise<void>) | undefined)?.({
      preventDefault: vi.fn(),
    });

    expect(onCommand).toHaveBeenCalledWith("session-1", "steer", "Show the latest output");
    expect(scrollToEnd).toHaveBeenCalledOnce();
  });

  it("leaves Shift+Enter untouched for the textarea's native newline behavior", () => {
    const output = renderControlledDashboard(composerDashboardProps());
    const { preventDefault, requestSubmit } = pressComposerKey(findComposerTextarea(output), "Enter", true);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("leaves Shift+Enter untouched when autocomplete suggestions are visible", () => {
    const props = composerDashboardProps({
      ...BASE_SESSION,
      skillCommands: [{ name: "skill:seo", description: "Audit search visibility" }],
    });
    let output = renderControlledDashboard(props);
    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "/" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const { preventDefault, requestSubmit } = pressComposerKey(findComposerTextarea(output), "Enter", true);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(findComposerTextarea(output).props.value).toBe("/");
  });

  it("leaves composing Enter untouched when autocomplete suggestions are visible", () => {
    const props = composerDashboardProps({
      ...BASE_SESSION,
      skillCommands: [{ name: "skill:seo", description: "Audit search visibility" }],
    });
    let output = renderControlledDashboard(props);
    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "/" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const { preventDefault, requestSubmit } = pressComposerKey(
      findComposerTextarea(output),
      "Enter",
      false,
      true,
    );
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(findComposerTextarea(output).props.value).toBe("/");
  });

  it.each(["Enter", "Tab"])(
    "accepts the active autocomplete suggestion with %s instead of submitting",
    (key) => {
      const props = composerDashboardProps({
        ...BASE_SESSION,
        skillCommands: [{ name: "skill:seo", description: "Audit search visibility" }],
      });
      let output = renderControlledDashboard(props);
      (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "/" },
      });
      output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

      const { preventDefault, requestSubmit } = pressComposerKey(findComposerTextarea(output), key);
      output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

      expect(preventDefault).toHaveBeenCalledOnce();
      expect(requestSubmit).not.toHaveBeenCalled();
      expect(findComposerTextarea(output)?.props.value).toBe("/skill:seo ");
    },
  );

  it("does not render a composer footer or its keyboard shortcut", () => {
    const output = renderControlledDashboard(composerDashboardProps());

    expect(findElements(output, (element) => element.props.className === "composer-footer")).toHaveLength(0);
    expect(textContent(output)).not.toContain("⌘ ↵ to send");
  });
});

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
    const multiButton = findElements(
      richMulti,
      (element) => element.props.className === "ask-option ask-rich-option",
    )[0];
    expect(multiLink?.props.href).toBe("https://omp.sh/multi");
    expect(findElements(multiButton, (element) => element.type === "a")).toHaveLength(0);
    (multiButton?.props.onClick as (() => void) | undefined)?.();
    const richMultiSelected = renderAskToolCall(richMultiRequest, { onActivity, onRespond }, true);
    expect(findElements(richMultiSelected, (element) => element.props["aria-pressed"] === true)).toHaveLength(
      1,
    );

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
    const radio = findElements(richRadio, (element) => element.type === Radio.Root)[0];
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
      (element) => element.props.className === "ask-option ask-rich-option",
    );
    expect(options[0]?.props["aria-pressed"]).toBe(false);
    (options[1]?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(RICH_ASK, { onRespond }, true);

    const custom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-rich-0-custom",
    )[0];
    const note = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-rich-0-note",
    )[0];
    (custom?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "CockroachDB" },
    });
    (note?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Needs horizontal scaling" },
    });
    output = renderAskToolCall(RICH_ASK, { onRespond }, true);
    const submit = findElements(
      output,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
    )[0];
    expect(submit?.props.disabled).toBe(false);
    (submit?.props.onClick as (() => void) | undefined)?.();
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

  it("shows one accessible question at a time with Base UI radios and progressive navigation", () => {
    let output = renderAskToolCall(MULTIPLE_RICH_ASK);
    let fieldsets = findElements(output, (element) => element.type === "fieldset");
    let legends = findElements(output, (element) => element.type === "legend");
    let radioGroups = findElements(output, (element) => element.type === RadioGroup);
    let radios = findElements(output, (element) => element.type === Radio.Root);

    expect(textContent(output)).toContain("2 questions");
    expect(textContent(output)).toContain("Question 1 of 2");
    expect(fieldsets).toHaveLength(1);
    expect(radioGroups).toHaveLength(1);
    expect(radios).toHaveLength(2);
    expect(radioGroups[0]?.props["aria-labelledby"]).toBe(legends[0]?.props.id);
    expect(radioGroups[0]?.props.disabled).toBe(false);
    expect(textContent(radios[0])).toContain("preview.example.test");
    const previous = findElements(output, (element) => textContent(element) === "Previous")[0];
    expect(previous?.props.disabled).toBe(true);

    const next = findElements(output, (element) => textContent(element) === "Next")[0];
    expect(next?.props.disabled).toBe(false);
    (next?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, {}, true);
    fieldsets = findElements(output, (element) => element.type === "fieldset");
    const toggleButtons = findElements(
      fieldsets[0],
      (element) => element.props.className === "ask-option ask-rich-option",
    );

    expect(textContent(output)).toContain("Question 2 of 2");
    expect(fieldsets).toHaveLength(1);
    expect(findElements(output, (element) => element.type === RadioGroup)).toHaveLength(0);
    expect(toggleButtons.map((button) => button.props["aria-pressed"])).toEqual([false, false]);

    const disconnected = renderAskToolCall(MULTIPLE_RICH_ASK, { connection: "disconnected" });
    expect(findElements(disconnected, (element) => element.type === RadioGroup)[0]?.props.disabled).toBe(
      true,
    );
    expect(
      findElements(
        disconnected,
        (element) =>
          element.props.className === "ask-option ask-rich-option" && "aria-pressed" in element.props,
      ).every((button) => button.props.disabled === true),
    ).toBe(true);
  });

  it("allows unanswered review, preserves indexed answers, gates final submit, and emits activity", async () => {
    const onActivity = vi.fn();
    const onRespond = vi.fn().mockResolvedValue(undefined);
    let output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond });
    const firstRadioGroup = findElements(output, (element) => element.type === RadioGroup)[0];
    (firstRadioGroup?.props.onValueChange as ((value: string) => void) | undefined)?.("Preview");
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);

    const firstCustom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-0-custom",
    )[0];
    const firstNote = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-0-note",
    )[0];
    (firstCustom?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Preview mirror" },
    });
    (firstNote?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Keep rollout private" },
    });
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);

    const next = findElements(output, (element) => textContent(element) === "Next")[0];
    (next?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);
    expect(textContent(output)).toContain("Question 2 of 2");
    expect(findElements(output, (element) => textContent(element) === "Submit answers")).toHaveLength(1);
    expect(
      findElements(
        output,
        (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
      )[0]?.props.disabled,
    ).toBe(true);

    const secondOption = findElements(
      output,
      (element) =>
        element.props.className === "ask-option ask-rich-option" && element.props["aria-pressed"] === false,
    )[0];
    (secondOption?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);
    const secondCustom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-1-custom",
    )[0];
    const secondNote = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-1-note",
    )[0];
    (secondCustom?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Run canary checks" },
    });
    (secondNote?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Before promotion" },
    });
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);
    const submit = findElements(
      output,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
    )[0];
    expect(submit?.props.disabled).toBe(false);

    const previous = findElements(output, (element) => textContent(element) === "Previous")[0];
    (previous?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);
    expect(textContent(output)).toContain("Question 1 of 2");
    expect(findElements(output, (element) => element.type === RadioGroup)[0]?.props.value).toBe("");
    expect(
      findElements(
        output,
        (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-0-custom",
      )[0]?.props.value,
    ).toBe("Preview mirror");
    expect(
      findElements(
        output,
        (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-0-note",
      )[0]?.props.value,
    ).toBe("Keep rollout private");

    (findElements(output, (element) => textContent(element) === "Next")[0]?.props.onClick as () => void)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);
    const finalSubmit = findElements(
      output,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
    )[0];
    (finalSubmit?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onRespond).toHaveBeenCalledWith({
      kind: "submit",
      results: [
        {
          id: "target",
          question: "Which deployment target?",
          options: ["Preview", "Production"],
          multi: false,
          selectedOptions: [],
          customInput: "Preview mirror",
          note: "Keep rollout private",
        },
        {
          id: "checks",
          question: "Which checks should run?",
          options: ["Smoke tests", "Full suite"],
          multi: true,
          selectedOptions: ["Smoke tests"],
          customInput: "Run canary checks",
          note: "Before promotion",
        },
      ],
    });
    expect(onActivity).toHaveBeenCalledTimes(6);
  });
  it("focuses the newly visible question heading after navigation", () => {
    let output = renderAskToolCall(MULTIPLE_RICH_ASK);
    const legend = findElements(output, (element) => element.type === "legend")[0];
    const focus = vi.fn();
    const headingRef = legend?.props.ref as { current: { focus(): void } | null } | undefined;
    if (headingRef) headingRef.current = { focus };

    const next = findElements(output, (element) => textContent(element) === "Next")[0];
    (next?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, {}, true);

    expect(textContent(output)).toContain("Question 2 of 2");
    expect(focus).toHaveBeenCalledOnce();
    expect(findElements(output, (element) => element.type === "legend")[0]?.props.tabIndex).toBe(-1);
  });

  it("keeps single-select options and custom answers mutually exclusive in both directions", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const onActivity = vi.fn();
    let output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity });
    expect(findElements(output, (element) => element.props.className === "ask-progress")).toHaveLength(0);
    expect(findElements(output, (element) => textContent(element) === "Previous")).toHaveLength(0);
    expect(findElements(output, (element) => textContent(element) === "Next")).toHaveLength(0);
    expect(findElements(output, (element) => textContent(element) === "Submit answers")).toHaveLength(1);

    let radioGroup = findElements(output, (element) => element.type === RadioGroup)[0];
    (radioGroup?.props.onValueChange as ((value: string) => void) | undefined)?.("Preview");
    output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity }, true);

    let custom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-single-rich-0-custom",
    )[0];
    expect(custom?.props.value).toBe("");
    (custom?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Staging" },
    });
    output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity }, true);
    radioGroup = findElements(output, (element) => element.type === RadioGroup)[0];
    expect(radioGroup?.props.value).toBe("");

    (radioGroup?.props.onValueChange as ((value: string) => void) | undefined)?.("Production");
    output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity }, true);
    custom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-single-rich-0-custom",
    )[0];
    expect(custom?.props.value).toBe("");
    const submit = findElements(
      output,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
    )[0];
    (submit?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onRespond).toHaveBeenCalledWith({
      kind: "submit",
      results: [
        {
          id: "target",
          question: "Which deployment target?",
          options: ["Preview", "Production"],
          multi: false,
          selectedOptions: ["Production"],
        },
      ],
    });
    expect(onActivity).toHaveBeenCalledTimes(3);
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
