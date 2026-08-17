// biome-ignore-all assist/source/organizeImports: The test support must install the React hook mock first.
import {
  findElements,
  getReactHarness,
  textContent,
} from "./dashboard/dashboard-test-support.js";
import { isValidElement, type ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApplicationErrorViewer,
  type ApplicationErrorViewerProps,
  formatBytes,
  formatErrorTimestamp,
} from "./application-error-viewer.js";
import type { ApplicationErrorRecord } from "./dashboard-props.js";
import { Button } from "./ui/button.js";
import { Collapsible } from "./ui/collapsible.js";
import { Dialog } from "./ui/dialog.js";

const reactHarness = getReactHarness();

function renderViewer(
  props: ApplicationErrorViewerProps,
  preserveState = false,
): ReactNode {
  if (!preserveState) {
    reactHarness.refValues = [];
    reactHarness.stateValues = [];
    reactHarness.callbackValues = [];
  }
  reactHarness.refIndex = 0;
  reactHarness.stateIndex = 0;
  reactHarness.callbackIndex = 0;
  const element = ApplicationErrorViewer(props);
  if (!isValidElement(element) || typeof element.type !== "function") return element;
  return (element.type as (props: typeof element.props) => ReactNode)(element.props);
}

const SAMPLE_ERROR_1: ApplicationErrorRecord = {
  id: "err-1",
  timestamp: "2026-08-16T10:00:00.000Z",
  source: "daemon",
  severity: "error",
  message: "Failed to bind daemon RPC socket at /tmp/omp.sock",
  errorName: "SocketBindError",
  stack: "SocketBindError: Failed to bind\n  at listen (daemon.ts:42:10)",
  context: {
    path: "/tmp/omp.sock",
    retryCount: 3,
    component: "DaemonRpc",
  },
};

const SAMPLE_ERROR_2: ApplicationErrorRecord = {
  id: "err-2",
  timestamp: "2026-08-17T14:30:00.000Z",
  source: "browser",
  severity: "fatal",
  message: "Uncaught WebGPU context lost during render loop",
  errorName: "RenderPipelineCrash",
  stack: "RenderPipelineCrash: Context lost\n  at renderLoop (canvas.ts:100:5)",
  context: {
    deviceId: "apple-m4",
    count: 0,
  },
};

describe("ApplicationErrorViewer formatters", () => {
  it("formats ISO timestamps into human-readable strings", () => {
    const formatted = formatErrorTimestamp("2026-08-17T14:30:00.000Z");
    expect(formatted).not.toBe("2026-08-17T14:30:00.000Z");
    expect(formatErrorTimestamp("invalid-time")).toBe("invalid-time");
  });

  it("formats bytes into readable byte/KB/MB sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("ApplicationErrorViewer deterministic states", () => {
  beforeEach(() => {
    vi.spyOn(toast, "success").mockReturnValue("toast-id");
  });

  it("renders the empty state when no errors exist", () => {
    const output = renderViewer({ errors: [] });

    expect(textContent(output)).toContain("No application errors");
    expect(textContent(output)).toContain("No daemon or browser errors have been recorded.");
    const clearButton = findElements(
      output,
      (element) =>
        typeof element.props.className === "string" &&
        element.props.className.includes("app-errors-clear-button"),
    )[0];
    expect(clearButton?.props.disabled).toBe(true);
    expect(clearButton?.props["aria-label"]).toBe("Clear all application errors");
  });

  it("renders the loading state when errors are loading and list is empty", () => {
    const output = renderViewer({ errors: [], loading: true });

    expect(textContent(output)).toContain("Loading application errors…");
    expect(findElements(output, (element) => element.props.role === "status")).toHaveLength(1);
  });

  it("renders a request error alert with retry button", async () => {
    const onReloadErrors = vi.fn().mockResolvedValue(undefined);
    const output = renderViewer({
      errors: [],
      error: "Daemon RPC disconnected unexpectedly",
      onReloadErrors,
    });

    expect(textContent(output)).toContain("Could not load application errors.");
    expect(textContent(output)).toContain("Daemon RPC disconnected unexpectedly");
    expect(textContent(output)).not.toContain("No application errors");

    const retryButton = findElements(
      output,
      (element) => element.type === Button && textContent(element) === "Retry",
    )[0];
    expect(retryButton).toBeDefined();
    await (retryButton?.props.onClick as (() => Promise<void>) | undefined)?.();
    expect(onReloadErrors).toHaveBeenCalledOnce();
  });

  it("handles reload rejection through the controlled error state", async () => {
    const onReloadErrors = vi.fn().mockRejectedValue(new Error("Daemon unavailable"));
    const output = renderViewer({
      errors: [],
      error: "Daemon unavailable",
      onReloadErrors,
    });

    const reloadControls = findElements(
      output,
      (element) =>
        element.type === Button &&
        (element.props["aria-label"] === "Reload application errors" ||
          textContent(element) === "Retry"),
    );
    expect(reloadControls).toHaveLength(2);

    for (const control of reloadControls) {
      (control.props.onClick as (() => void) | undefined)?.();
    }
    await Promise.resolve();

    expect(onReloadErrors).toHaveBeenCalledTimes(2);
  });

  it("renders degraded storage health banner when status is degraded", () => {
    const output = renderViewer({
      errors: [SAMPLE_ERROR_1],
      health: {
        status: "degraded",
        recordCount: 1,
        totalBytes: 1024,
        oldestTimestamp: "2026-08-16T10:00:00.000Z",
        newestTimestamp: "2026-08-16T10:00:00.000Z",
        degradedReason: "Ledger storage reached quota limit",
      },
    });

    expect(textContent(output)).toContain("Storage degraded");
    expect(textContent(output)).toContain("Ledger storage reached quota limit");
    expect(textContent(output)).toContain("Degraded");
  });
});

describe("ApplicationErrorViewer populated list and filtering", () => {
  it("renders records newest-first with severity and source badges", () => {
    const output = renderViewer({
      errors: [SAMPLE_ERROR_1, SAMPLE_ERROR_2],
    });

    const articles = findElements(output, (element) => element.type === "article");
    expect(articles).toHaveLength(2);

    // SAMPLE_ERROR_2 (Aug 17) should appear before SAMPLE_ERROR_1 (Aug 16)
    expect(textContent(articles[0])).toContain("Uncaught WebGPU context lost during render loop");
    expect(textContent(articles[0])).toContain("fatal");
    expect(textContent(articles[0])).toContain("browser");

    expect(textContent(articles[1])).toContain("Failed to bind daemon RPC socket");
    expect(textContent(articles[1])).toContain("error");
    expect(textContent(articles[1])).toContain("daemon");
  });

  it("labels records without an error name from their message", () => {
    const unnamedError: ApplicationErrorRecord = {
      id: "err-without-name",
      timestamp: "2026-08-17T15:00:00.000Z",
      source: "browser",
      severity: "error",
      message: "A nameless browser failure",
    };
    const output = renderViewer({ errors: [unnamedError] });
    const article = findElements(output, (element) => element.type === "article")[0];
    const message = findElements(
      output,
      (element) => element.props.id === "error-message-err-without-name",
    )[0];

    expect(article?.props["aria-labelledby"]).toBe("error-message-err-without-name");
    expect(textContent(message)).toBe("A nameless browser failure");
  });

  it("filters records by source and severity and supports filter reset", () => {
    let output = renderViewer({
      errors: [SAMPLE_ERROR_1, SAMPLE_ERROR_2],
    });

    const filterButtons = findElements(
      output,
      (element) => element.type === Button && typeof element.props.onClick === "function",
    );

    const daemonFilter = filterButtons.find((btn) => textContent(btn) === "Daemon");
    expect(daemonFilter).toBeDefined();

    // Click Daemon filter
    (daemonFilter?.props.onClick as (() => void) | undefined)?.();
    output = renderViewer(
      {
        errors: [SAMPLE_ERROR_1, SAMPLE_ERROR_2],
      },
      true,
    );

    // After filtering by Daemon, only SAMPLE_ERROR_1 should be shown
    let articles = findElements(output, (element) => element.type === "article");
    expect(articles).toHaveLength(1);
    expect(textContent(articles[0])).toContain("Failed to bind daemon RPC socket");

    // Reset button should exist when filters are active
    const resetButton = findElements(
      output,
      (element) => element.type === Button && textContent(element) === "Reset filters",
    )[0];
    expect(resetButton).toBeDefined();
    (resetButton?.props.onClick as (() => void) | undefined)?.();

    output = renderViewer(
      {
        errors: [SAMPLE_ERROR_1, SAMPLE_ERROR_2],
      },
      true,
    );
    articles = findElements(output, (element) => element.type === "article");
    expect(articles).toHaveLength(2);
  });

  it("renders filtered empty state when filters match zero records", () => {
    let output = renderViewer({
      errors: [SAMPLE_ERROR_1],
    });

    expect(textContent(output)).toContain("Failed to bind daemon RPC socket");

    const filterButtons = findElements(
      output,
      (element) => element.type === Button && typeof element.props.onClick === "function",
    );
    const browserFilter = filterButtons.find((btn) => textContent(btn) === "Browser");
    expect(browserFilter).toBeDefined();

    (browserFilter?.props.onClick as (() => void) | undefined)?.();
    output = renderViewer(
      {
        errors: [SAMPLE_ERROR_1],
      },
      true,
    );

    expect(textContent(output)).toContain("No matching errors");
    expect(textContent(output)).toContain("No recorded errors match the selected source");
  });
});

describe("ApplicationErrorViewer expandable details", () => {
  it("toggles expanded details showing stack trace and context", () => {
    let output = renderViewer({
      errors: [SAMPLE_ERROR_1],
    });

    let disclosure = findElements(output, (element) => element.type === Collapsible)[0];
    expect(disclosure?.props.open).toBe(false);
    expect(textContent(disclosure)).toContain("View details");

    (disclosure?.props.onOpenChange as ((open: boolean) => void) | undefined)?.(true);
    output = renderViewer({ errors: [SAMPLE_ERROR_1] }, true);

    disclosure = findElements(output, (element) => element.type === Collapsible)[0];
    expect(disclosure?.props.open).toBe(true);
    expect(textContent(disclosure)).toContain("Hide details");
    expect(textContent(disclosure)).toContain("SocketBindError: Failed to bind");
    expect(textContent(disclosure)).toContain("/tmp/omp.sock");

    (disclosure?.props.onOpenChange as ((open: boolean) => void) | undefined)?.(false);
    output = renderViewer({ errors: [SAMPLE_ERROR_1] }, true);

    disclosure = findElements(output, (element) => element.type === Collapsible)[0];
    expect(disclosure?.props.open).toBe(false);
    expect(textContent(disclosure)).toContain("View details");
  });
});

describe("ApplicationErrorViewer clear-all confirmation dialog", () => {
  beforeEach(() => {
    vi.spyOn(toast, "success").mockReturnValue("toast-id");
  });

  it("opens confirmation dialog, handles cancel and confirmation", async () => {
    const onClearErrors = vi.fn().mockResolvedValue(undefined);
    let output = renderViewer({
      errors: [SAMPLE_ERROR_1],
      onClearErrors,
    });

    const clearAllButton = findElements(
      output,
      (element) =>
        typeof element.props.className === "string" &&
        element.props.className.includes("app-errors-clear-button"),
    )[0];
    expect(clearAllButton?.props.disabled).toBe(false);

    // Open confirmation dialog
    (clearAllButton?.props.onClick as (() => void) | undefined)?.();
    output = renderViewer(
      {
        errors: [SAMPLE_ERROR_1],
        onClearErrors,
      },
      true,
    );

    const dialog = findElements(output, (element) => element.type === Dialog)[0];
    expect(dialog).toBeDefined();
    expect(dialog?.props.title).toBe("Clear application errors?");
    expect(dialog?.props.open).toBe(true);

    const dialogButtons = findElements(dialog, (element) => element.type === Button);
    const confirmButton = dialogButtons.find((btn) => textContent(btn) === "Clear errors");
    expect(confirmButton).toBeDefined();

    // Confirm clear
    await (confirmButton?.props.onClick as (() => Promise<void>) | undefined)?.();
    expect(onClearErrors).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith("Application errors cleared");

    output = renderViewer(
      {
        errors: [SAMPLE_ERROR_1],
        onClearErrors,
      },
      true,
    );
    const closedDialog = findElements(output, (element) => element.type === Dialog)[0];
    expect(closedDialog?.props.open).toBe(false);
  });

  it("displays clear error inside dialog when clear operation fails", async () => {
    const onClearErrors = vi.fn().mockRejectedValue(new Error("Permission denied on ledger file"));
    let output = renderViewer({
      errors: [SAMPLE_ERROR_1],
      onClearErrors,
    });

    const clearAllButton = findElements(
      output,
      (element) =>
        typeof element.props.className === "string" &&
        element.props.className.includes("app-errors-clear-button"),
    )[0];
    (clearAllButton?.props.onClick as (() => void) | undefined)?.();

    output = renderViewer(
      {
        errors: [SAMPLE_ERROR_1],
        onClearErrors,
      },
      true,
    );

    const dialog = findElements(output, (element) => element.type === Dialog)[0];
    const confirmButton = findElements(
      dialog,
      (btn) => btn.type === Button && textContent(btn) === "Clear errors",
    )[0];

    await (confirmButton?.props.onClick as (() => Promise<void>) | undefined)?.();
    expect(onClearErrors).toHaveBeenCalledOnce();

    output = renderViewer(
      {
        errors: [SAMPLE_ERROR_1],
        onClearErrors,
      },
      true,
    );
    const dialogWithError = findElements(output, (element) => element.type === Dialog)[0];
    expect(dialogWithError?.props.open).toBe(true);
    expect(textContent(dialogWithError)).toContain("Permission denied on ledger file");
  });
});

describe("ApplicationErrorViewer navigation", () => {
  it("calls onBackToSessions when back button is clicked", () => {
    const onBackToSessions = vi.fn();
    const output = renderViewer({
      errors: [SAMPLE_ERROR_1],
      onBackToSessions,
    });

    const backButton = findElements(
      output,
      (element) =>
        typeof element.props.className === "string" &&
        element.props.className.includes("app-errors-back-button"),
    )[0];
    expect(backButton).toBeDefined();
    expect(backButton?.props["aria-label"]).toBe("Back to sessions");

    (backButton?.props.onClick as (() => void) | undefined)?.();
    expect(onBackToSessions).toHaveBeenCalledOnce();
  });
});
