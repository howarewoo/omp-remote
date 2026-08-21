import {
  BASE_SESSION,
  composerDashboardProps,
  findElements,
  renderControlledDashboard,
  textContent,
} from "./dashboard-test-support.js";
import type { ReactElement, ReactNode } from "react";
import { toast } from "sonner";
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

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("dashboard session command lifecycle and cross-session ownership", () => {
  it("preserves session B composer action and truthful kill state while session A message command is pending, and ignores stale A completion", async () => {
    const sessionA = { ...BASE_SESSION, id: "session-a", name: "Session A" };
    const sessionB = {
      ...BASE_SESSION,
      id: "session-b",
      name: "Session B",
      source: "rpc" as const,
      capabilities: [...BASE_SESSION.capabilities, "kill" as const],
    };
    const deferredA = createDeferred<void>();
    const onCommand = vi.fn((sessionId: string) =>
      sessionId === "session-a" ? deferredA.promise : Promise.resolve(),
    );
    const onKill = vi.fn().mockResolvedValue(undefined);
    let props = {
      ...composerDashboardProps(sessionA),
      sessions: [sessionA, sessionB],
      selectedSessionId: "session-a",
      onCommand,
      onKill,
    };

    let output = renderControlledDashboard(props);
    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "draft for session A" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const formA = findElements(output, (element) => element.props.className === "composer")[0];
    const submitPromiseA = (
      formA?.props.onSubmit as ((event: { preventDefault(): void }) => Promise<void>) | undefined
    )?.({ preventDefault: vi.fn() });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // Switch to session B while session A command is still pending
    props = { ...props, selectedSessionId: "session-b" };
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // Verify session B composer is enabled and not marked as sending
    const formB = findElements(output, (element) => element.props.className === "composer")[0];
    expect(formB).toBeDefined();
    const sendButtonB = findElements(
      formB,
      (element) => element.props["aria-label"] === "Send instruction",
    )[0];
    expect(sendButtonB?.props.disabled).toBeFalsy();

    // Open session B kill confirmation dialog
    const killButton = findElements(output, (element) => element.props["aria-label"] === "Kill Session B")[0];
    expect(killButton).toBeDefined();
    (killButton?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const killDialog = findElements(output, (element) => element.props.title === "Kill this session?")[0];
    if (!killDialog) throw new Error("Expected Kill session dialog to be rendered");
    expect(killDialog.props.open).toBe(true);
    expect(killDialog.props.dismissible).toBe(true);
    const killDialogAlerts = findElements(killDialog, (element) => element.props.role === "alert");
    expect(killDialogAlerts).toHaveLength(0);
    const killDialogText = textContent(killDialog);
    expect(killDialogText).toContain("Kill session");
    expect(killDialogText).not.toContain("Killing…");
    expect(onKill).not.toHaveBeenCalled();

    // Edit session B's draft
    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "edited draft for session B" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // Resolve session A's deferred command
    deferredA.resolve();
    await submitPromiseA;
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // Assert session B's draft is not cleared and no errors are shown
    expect(findComposerTextarea(output).props.value).toBe("edited draft for session B");
    expect(findElements(output, (element) => element.props.role === "alert")).toHaveLength(0);
  });

  it("preserves submitted draft and exposes actionable error on command failure or timeout", async () => {
    const sessionA = { ...BASE_SESSION, id: "session-a", name: "Session A" };
    const deferredA = createDeferred<void>();
    const onCommand = vi.fn().mockReturnValue(deferredA.promise);
    const props = {
      ...composerDashboardProps(sessionA),
      sessions: [sessionA],
      selectedSessionId: "session-a",
      onCommand,
    };

    let output = renderControlledDashboard(props);
    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "important draft to preserve" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const form = findElements(output, (element) => element.props.className === "composer")[0];
    const submitPromise = (
      form?.props.onSubmit as ((event: { preventDefault(): void }) => Promise<void>) | undefined
    )?.({ preventDefault: vi.fn() });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    deferredA.reject(new Error("The host did not respond before the command timed out"));
    await submitPromise?.catch(() => undefined);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(findComposerTextarea(output).props.value).toBe("important draft to preserve");
    const errorAlert = findElements(output, (element) => element.props.role === "alert")[0];
    expect(textContent(errorAlert)).toContain("The host did not respond before the command timed out");
  });

  it("clears only the exact unchanged draft on correlated success", async () => {
    const sessionA = { ...BASE_SESSION, id: "session-a", name: "Session A" };
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const props = {
      ...composerDashboardProps(sessionA),
      sessions: [sessionA],
      selectedSessionId: "session-a",
      onCommand,
    };

    let output = renderControlledDashboard(props);
    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "draft to clear" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const form = findElements(output, (element) => element.props.className === "composer")[0];
    await (form?.props.onSubmit as ((event: { preventDefault(): void }) => Promise<void>) | undefined)?.({
      preventDefault: vi.fn(),
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(findComposerTextarea(output).props.value).toBe("");
  });

  it("handles concurrent submissions for session A and session B independently", async () => {
    const sessionA = { ...BASE_SESSION, id: "session-a", name: "Session A" };
    const sessionB = { ...BASE_SESSION, id: "session-b", name: "Session B" };
    const deferredA = createDeferred<void>();
    const deferredB = createDeferred<void>();
    const onCommand = vi.fn((sessionId: string) =>
      sessionId === "session-a" ? deferredA.promise : deferredB.promise,
    );
    let props = {
      ...composerDashboardProps(sessionA),
      sessions: [sessionA, sessionB],
      selectedSessionId: "session-a",
      onCommand,
    };

    let output = renderControlledDashboard(props);
    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "draft A" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const formA = findElements(output, (element) => element.props.className === "composer")[0];
    const submitPromiseA = (
      formA?.props.onSubmit as ((event: { preventDefault(): void }) => Promise<void>) | undefined
    )?.({ preventDefault: vi.fn() });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // Switch to session B
    props = { ...props, selectedSessionId: "session-b" };
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findComposerTextarea(output).props.value).toBe("");

    // Enter draft for session B and submit
    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "draft B" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const formB = findElements(output, (element) => element.props.className === "composer")[0];
    const submitPromiseB = (
      formB?.props.onSubmit as ((event: { preventDefault(): void }) => Promise<void>) | undefined
    )?.({ preventDefault: vi.fn() });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // Resolve session B
    deferredB.resolve();
    await submitPromiseB;
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findComposerTextarea(output).props.value).toBe("");

    // Switch back to session A: still shows draft A
    props = { ...props, selectedSessionId: "session-a" };
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findComposerTextarea(output).props.value).toBe("draft A");

    // Reject session A
    deferredA.reject(new Error("Command on session A failed"));
    await submitPromiseA?.catch(() => undefined);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(findComposerTextarea(output).props.value).toBe("draft A");
    const alertA = findElements(output, (element) => element.props.role === "alert")[0];
    expect(textContent(alertA)).toContain("Command on session A failed");

    // Switch back to session B: no error displayed
    props = { ...props, selectedSessionId: "session-b" };
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findElements(output, (element) => element.props.role === "alert")).toHaveLength(0);
  });

  it("scopes message and kill errors independently without cross-operation contamination", async () => {
    const sessionA = {
      ...BASE_SESSION,
      id: "session-a",
      name: "Session A",
      source: "rpc" as const,
      capabilities: [...BASE_SESSION.capabilities, "kill" as const],
    };
    const onCommand = vi.fn().mockRejectedValue(new Error("Message instruction failed"));
    const onKill = vi.fn().mockRejectedValue(new Error("Kill process failed"));
    let props = {
      ...composerDashboardProps(sessionA),
      sessions: [sessionA],
      selectedSessionId: "session-a",
      onCommand,
      onKill,
    };

    let output = renderControlledDashboard(props);
    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "instruction text" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const form = findElements(output, (element) => element.props.className === "composer")[0];
    await (form?.props.onSubmit as ((event: { preventDefault(): void }) => Promise<void>) | undefined)?.({
      preventDefault: vi.fn(),
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // Composer shows message error
    const composerAlert = findElements(output, (element) => element.props.role === "alert")[0];
    expect(textContent(composerAlert)).toContain("Message instruction failed");

    // Open Kill dialog: must NOT display message error
    const killButton = findElements(output, (element) => element.props["aria-label"] === "Kill Session A")[0];
    (killButton?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const killDialog = findElements(output, (element) => element.props.title === "Kill this session?")[0];
    if (!killDialog) throw new Error("Expected kill dialog");
    expect(findElements(killDialog, (element) => element.props.role === "alert")).toHaveLength(0);

    // Trigger kill action inside dialog
    const killActionBtn = findElements(killDialog, (element) => element.props.variant === "destructive")[0];
    await (killActionBtn?.props.onClick as (() => Promise<void>) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // Kill dialog now shows kill error
    const killDialogWithErr = findElements(
      output,
      (element) => element.props.title === "Kill this session?",
    )[0];
    if (!killDialogWithErr) throw new Error("Expected kill dialog");
    const killAlert = findElements(killDialogWithErr, (element) => element.props.role === "alert")[0];
    expect(textContent(killAlert)).toContain("Kill process failed");

    // Main composer area still has its message error
    const composerAlertAfterKill = findElements(
      output,
      (element) => element.props.role === "alert" && textContent(element).includes("Message instruction"),
    )[0];
    expect(composerAlertAfterKill).toBeDefined();
  });

  it("surfaces abort failure as an error toast when interruption fails", async () => {
    vi.spyOn(toast, "error").mockReturnValue("toast-id");
    const sessionA = { ...BASE_SESSION, id: "session-a", status: "running" as const };
    const onAbort = vi.fn().mockRejectedValue(new Error("Abort failed"));
    const props = {
      ...composerDashboardProps(sessionA),
      sessions: [sessionA],
      selectedSessionId: "session-a",
      onAbort,
    };

    let output = renderControlledDashboard(props);
    const form = findElements(output, (element) => element.props.className === "composer")[0];
    await (form?.props.onSubmit as ((event: { preventDefault(): void }) => Promise<void>) | undefined)?.({
      preventDefault: vi.fn(),
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const abortDialog = findElements(output, (element) => element.props.title === "Abort this run?")[0];
    if (!abortDialog) throw new Error("Expected Abort dialog");
    expect(abortDialog.props.open).toBe(true);

    const abortButton = findElements(abortDialog, (element) => element.props.variant === "destructive")[0];
    await (abortButton?.props.onClick as (() => Promise<void>) | undefined)?.();

    expect(onAbort).toHaveBeenCalledWith("session-a");
    expect(toast.error).toHaveBeenCalledWith("Abort failed");
  });
});
