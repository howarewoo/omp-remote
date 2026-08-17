import {
  APPLICATION_ERROR_MESSAGE_MAX_CHARS,
  APPLICATION_ERROR_NAME_MAX_CHARS,
  APPLICATION_ERROR_STACK_MAX_CHARS,
  type ApplicationErrorContext,
  sanitizeApplicationErrorContext,
} from "@omp-remote/protocol";
import { useEffect } from "react";

export interface BrowserApplicationErrorInput {
  id?: string | undefined;
  timestamp?: string | undefined;
  source: "browser";
  severity: "error" | "fatal";
  message: string;
  errorName?: string | undefined;
  stack?: string | undefined;
  context?: ApplicationErrorContext | undefined;
}

export interface ApplicationErrorReporter {
  reportApplicationError(error: BrowserApplicationErrorInput): Promise<void>;
}

const BENIGN_ERROR_PATTERNS = [
  /ResizeObserver loop completed with undelivered notifications/i,
  /ResizeObserver loop limit exceeded/i,
];

export function isIgnoredError(error: unknown, message?: string): boolean {
  try {
    if (error instanceof DOMException && error.name === "AbortError") {
      return true;
    }
  } catch {
    // DOMException name getter threw
  }
  if (typeof error === "object" && error !== null) {
    try {
      const errorObj = error as { name?: unknown; message?: unknown };
      let errorName: unknown;
      let errorMessage: unknown;
      try {
        errorName = errorObj.name;
      } catch {
        // name getter threw
      }
      try {
        errorMessage = errorObj.message;
      } catch {
        // message getter threw
      }
      if (errorName === "AbortError") {
        return true;
      }
      if (typeof errorMessage === "string") {
        if (
          errorMessage.includes("The user aborted a request") ||
          errorMessage.includes("signal is aborted") ||
          BENIGN_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
        ) {
          return true;
        }
      }
    } catch {
      // Object property access threw
    }
  }
  if (typeof message === "string") {
    if (
      message.includes("The user aborted a request") ||
      message.includes("signal is aborted") ||
      BENIGN_ERROR_PATTERNS.some((pattern) => pattern.test(message))
    ) {
      return true;
    }
  }
  return false;
}

function extractSafeShallowString(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "object") {
    try {
      const candidate = String(value);
      if (candidate && candidate !== "[object Object]") {
        return candidate;
      }
    } catch {
      // Custom toString threw
    }
    try {
      const keys = Object.keys(value as object).slice(0, 10);
      if (keys.length === 0) return "{}";
      const entries: string[] = [];
      for (const key of keys) {
        let valStr = "[Unserializable]";
        try {
          const val = (value as Record<string, unknown>)[key];
          if (val === null) valStr = "null";
          else if (val === undefined) valStr = "undefined";
          else if (typeof val === "string") valStr = JSON.stringify(val.slice(0, 100));
          else if (typeof val === "number" || typeof val === "boolean") valStr = String(val);
          else if (typeof val === "object") valStr = Array.isArray(val) ? "[Array]" : "[Object]";
          else valStr = typeof val;
        } catch {
          // Property getter threw
        }
        entries.push(`${key}: ${valStr}`);
      }
      return `{ ${entries.join(", ")} }`;
    } catch {
      return "[Object]";
    }
  }
  return String(value);
}

export function normalizeUnknownError(
  error: unknown,
  fallbackMessage = "Unknown browser error",
  initialContext?: Record<string, unknown>,
): BrowserApplicationErrorInput {
  let message = fallbackMessage;
  let errorName: string | undefined;
  let stack: string | undefined;

  if (error instanceof Error) {
    try {
      if (typeof error.message === "string" && error.message.trim().length > 0) {
        message = error.message.trim();
      } else if (typeof error.name === "string" && error.name.trim().length > 0) {
        message = error.name.trim();
      }
    } catch {
      // message or name getter threw
    }
    try {
      if (typeof error.name === "string" && error.name.trim().length > 0) {
        errorName = error.name.trim();
      }
    } catch {
      // name getter threw
    }
    try {
      if (typeof error.stack === "string" && error.stack.trim().length > 0) {
        stack = error.stack;
      }
    } catch {
      // stack getter threw
    }
  } else if (typeof error === "object" && error !== null) {
    let extractedMessage = false;
    try {
      const errorObj = error as { name?: unknown; message?: unknown; stack?: unknown };
      if (typeof errorObj.message === "string" && errorObj.message.trim().length > 0) {
        message = errorObj.message.trim();
        extractedMessage = true;
      }
      if (typeof errorObj.name === "string" && errorObj.name.trim().length > 0) {
        errorName = errorObj.name.trim();
        if (!extractedMessage) {
          message = errorName;
          extractedMessage = true;
        }
      }
      if (typeof errorObj.stack === "string" && errorObj.stack.trim().length > 0) {
        stack = errorObj.stack;
      }
    } catch {
      // getters threw
    }
    if (!extractedMessage) {
      message = extractSafeShallowString(error);
    }
  } else if (typeof error === "string" && error.trim().length > 0) {
    message = error.trim();
  } else if (error !== null && error !== undefined) {
    message = extractSafeShallowString(error);
  }

  if (message.length > APPLICATION_ERROR_MESSAGE_MAX_CHARS) {
    message = `${message.slice(0, APPLICATION_ERROR_MESSAGE_MAX_CHARS - 1)}…`;
  }
  if (!message || message.trim().length === 0) {
    message = fallbackMessage;
  }

  if (errorName && errorName.length > APPLICATION_ERROR_NAME_MAX_CHARS) {
    errorName = errorName.slice(0, APPLICATION_ERROR_NAME_MAX_CHARS);
  }
  if (errorName && errorName.trim().length === 0) {
    errorName = undefined;
  }

  if (stack && stack.length > APPLICATION_ERROR_STACK_MAX_CHARS) {
    stack = stack.slice(0, APPLICATION_ERROR_STACK_MAX_CHARS);
  }

  const rawContext: Record<string, unknown> = { ...(initialContext ?? {}) };
  if (typeof window !== "undefined" && window.location?.pathname) {
    rawContext.pathname = window.location.pathname;
  }
  const context: ApplicationErrorContext | undefined = sanitizeApplicationErrorContext(rawContext);

  return {
    source: "browser",
    severity: "error",
    message,
    ...(errorName ? { errorName } : {}),
    ...(stack ? { stack } : {}),
    ...(context ? { context } : {}),
  };
}

export function normalizeErrorEvent(event: ErrorEvent | Event): BrowserApplicationErrorInput | null {
  let rawError: unknown;
  let rawMessage: unknown;
  let filename: unknown;
  let lineno: unknown;
  let colno: unknown;
  try {
    const errorEvent = event as ErrorEvent;
    if ("error" in errorEvent) rawError = errorEvent.error;
    if ("message" in errorEvent && typeof errorEvent.message === "string") rawMessage = errorEvent.message;
    if ("filename" in errorEvent && typeof errorEvent.filename === "string") filename = errorEvent.filename;
    if ("lineno" in errorEvent && typeof errorEvent.lineno === "number") lineno = errorEvent.lineno;
    if ("colno" in errorEvent && typeof errorEvent.colno === "number") colno = errorEvent.colno;
  } catch {
    // Event getters threw
  }

  if (isIgnoredError(rawError, typeof rawMessage === "string" ? rawMessage : undefined)) {
    return null;
  }

  const context: Record<string, unknown> = {};
  if (typeof filename === "string" && filename.length > 0) {
    context.filePath = filename;
  }
  if (typeof lineno === "number" && lineno > 0) {
    context.line = lineno;
  }
  if (typeof colno === "number" && colno > 0) {
    context.column = colno;
  }

  const fallbackMessage =
    typeof rawMessage === "string" && rawMessage.trim().length > 0
      ? rawMessage.trim()
      : "Uncaught window error";

  return normalizeUnknownError(rawError ?? rawMessage, fallbackMessage, context);
}

export function normalizeUnhandledRejectionEvent(
  event: PromiseRejectionEvent | Event,
): BrowserApplicationErrorInput | null {
  let reason: unknown;
  try {
    const rejectionEvent = event as PromiseRejectionEvent;
    if ("reason" in rejectionEvent) reason = rejectionEvent.reason;
  } catch {
    // Event getter threw
  }

  if (isIgnoredError(reason)) {
    return null;
  }

  return normalizeUnknownError(reason, "Unhandled promise rejection");
}

export function installBrowserErrorCapture(
  client: ApplicationErrorReporter,
  target: EventTarget = window,
): () => void {
  const onError = (event: Event) => {
    try {
      const input = normalizeErrorEvent(event);
      if (!input) return;
      void client.reportApplicationError(input).catch(() => {
        // Observer failures must never throw or recurse
      });
    } catch {
      // Isolation: never throw from error listener
    }
  };

  const onUnhandledRejection = (event: Event) => {
    try {
      const input = normalizeUnhandledRejectionEvent(event);
      if (!input) return;
      void client.reportApplicationError(input).catch(() => {
        // Observer failures must never throw or recurse
      });
    } catch {
      // Isolation: never throw from rejection listener
    }
  };

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

export function useBrowserErrorCapture(client: ApplicationErrorReporter): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    return installBrowserErrorCapture(client, window);
  }, [client]);
}
