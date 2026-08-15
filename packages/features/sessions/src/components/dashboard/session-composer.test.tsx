import {
  BASE_SESSION,
  composerDashboardProps,
  findElements,
  renderControlledDashboard,
  textContent,
} from "./dashboard-test-support.js";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MessageScrollerScrollController } from "../dashboard.js";

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

    expect(onCommand).toHaveBeenCalledWith("session-1", "prompt", "Show the latest output");
    expect(scrollToEnd).toHaveBeenCalledOnce();
  });

  it("queues a follow-up instead of interrupting a running session", async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const props = {
      ...composerDashboardProps({ ...BASE_SESSION, status: "running" }),
      onCommand,
    };
    let output = renderControlledDashboard(props);

    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Run this when the current turn finishes" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const form = findElements(output, (element) => element.props.className === "composer")[0];
    await (form?.props.onSubmit as ((event: { preventDefault(): void }) => Promise<void>) | undefined)?.({
      preventDefault: vi.fn(),
    });

    expect(onCommand).toHaveBeenCalledWith(
      "session-1",
      "follow_up",
      "Run this when the current turn finishes",
    );
  });

  it("renders queued messages in the transcript with a cancel action", () => {
    const onCancelQueuedMessage = vi.fn();
    const output = renderControlledDashboard({
      ...composerDashboardProps({ ...BASE_SESSION, status: "running" }),
      queuedMessages: [
        {
          id: "queued-1",
          sessionId: "session-1",
          text: "Run the focused verification next",
          createdAt: "2026-08-14T12:00:00.000Z",
          status: "queued",
        },
      ],
      onCancelQueuedMessage,
    });
    const queuedRow = findElements(
      output,
      (element) => element.props.className === "transcript-entry transcript-user transcript-queued-message",
    )[0];
    const cancel = findElements(
      queuedRow,
      (element) => element.props["aria-label"] === "Cancel queued message",
    )[0];

    expect(textContent(queuedRow)).toContain("Queued");
    expect(textContent(queuedRow)).toContain("Run the focused verification next");
    (cancel?.props.onClick as (() => void) | undefined)?.();
    expect(onCancelQueuedMessage).toHaveBeenCalledWith("queued-1");
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
