import { describe, expect, it } from "vitest";
import {
  ApplicationErrorAddedFrameSchema,
  ApplicationErrorsClearedFrameSchema,
  BrowserCommandSchema,
  NotificationEventSchema,
  PushEventPreferencesSchema,
  PushSubscriptionSchema,
  ReportApplicationErrorCommandSchema,
  ServerFrameSchema,
  SessionBranchTopologySchema,
} from "./index.js";

describe("BrowserCommandSchema", () => {
  it("accepts RPC launch requests", () => {
    expect(
      BrowserCommandSchema.parse({
        type: "launch",
        requestId: "launch-1",
        cwd: "/workspace/project",
        resume: null,
      }),
    ).toEqual({
      type: "launch",
      requestId: "launch-1",
      cwd: "/workspace/project",
      resume: null,
    });
  });

  it.each([
    { command: "prompt", text: "Run the checks" },
    { command: "steer", text: "Focus on the API" },
    { command: "follow_up", text: "Then summarize" },
  ] as const)("accepts $command session commands", ({ command, text }) => {
    expect(
      BrowserCommandSchema.parse({
        type: "session_command",
        requestId: `${command}-1`,
        sessionId: "session-1",
        command,
        text,
      }),
    ).toMatchObject({ command, text });
  });

  it.each(["save_working_directory", "remove_working_directory"] as const)(
    "accepts and trims %s commands",
    (type) => {
      expect(
        BrowserCommandSchema.parse({
          type,
          requestId: `${type}-1`,
          cwd: "  /workspace/project  ",
        }),
      ).toEqual({
        type,
        requestId: `${type}-1`,
        cwd: "/workspace/project",
      });
    },
  );

  it.each(["save_working_directory", "remove_working_directory"] as const)(
    "rejects an empty cwd for %s commands",
    (type) => {
      expect(() =>
        BrowserCommandSchema.parse({
          type,
          requestId: `${type}-1`,
          cwd: " ",
        }),
      ).toThrow();
    },
  );

  it("accepts abort without command text", () => {
    expect(
      BrowserCommandSchema.parse({
        type: "session_command",
        requestId: "abort-1",
        sessionId: "session-1",
        command: "abort",
      }),
    ).toMatchObject({ command: "abort" });
  });

  it("accepts kill without command text", () => {
    expect(
      BrowserCommandSchema.parse({
        type: "session_command",
        requestId: "kill-1",
        sessionId: "session-1",
        command: "kill",
      }),
    ).toMatchObject({ command: "kill" });
  });

  it("accepts model and effort session controls", () => {
    for (const model of ["openai/gpt-5.6", "@slow"]) {
      expect(
        BrowserCommandSchema.parse({
          type: "session_command",
          requestId: "m-1",
          sessionId: "s-1",
          command: "set_model",
          model,
        }),
      ).toMatchObject({ command: "set_model", model });
    }
    expect(
      BrowserCommandSchema.parse({
        type: "session_command",
        requestId: "e-1",
        sessionId: "s-1",
        command: "set_effort",
        effort: "high",
      }),
    ).toMatchObject({ command: "set_effort", effort: "high" });
    for (const model of ["@", "@invalid/slash", "invalid-model"]) {
      expect(() =>
        BrowserCommandSchema.parse({
          type: "session_command",
          requestId: "m-inv",
          sessionId: "s-1",
          command: "set_model",
          model,
        }),
      ).toThrow();
    }
  });

  it.each([
    { response: { value: "PostgreSQL" } },
    { response: { cancelled: true } },
    { response: { cancelled: true, timedOut: true } },
    { response: { kind: "chat" } },
    {
      response: {
        kind: "submit",
        results: [
          {
            id: "database",
            question: "",
            options: ["SQLite", "PostgreSQL"],
            multi: true,
            selectedOptions: ["PostgreSQL"],
            customInput: "CockroachDB",
            note: "Needs horizontal scaling",
            timedOut: false,
          },
        ],
      },
    },
  ] as const)("accepts ask responses", ({ response }) => {
    expect(
      BrowserCommandSchema.parse({
        type: "ask_response",
        requestId: "dashboard-request-1",
        sessionId: "session-1",
        askRequestId: "ask-1",
        response,
      }),
    ).toMatchObject({ type: "ask_response", response });
  });

  it("accepts only the canonical browser ask activity shape", () => {
    expect(
      BrowserCommandSchema.parse({
        type: "ask_activity",
        sessionId: "session-1",
        askRequestId: "ask-1",
      }),
    ).toEqual({
      type: "ask_activity",
      sessionId: "session-1",
      askRequestId: "ask-1",
    });
    expect(() =>
      BrowserCommandSchema.parse({
        type: "ask_activity",
        sessionId: "session-1",
        requestId: "ask-1",
      }),
    ).toThrow();
  });

  it("rejects ambiguous ask responses", () => {
    expect(() =>
      BrowserCommandSchema.parse({
        type: "ask_response",
        requestId: "dashboard-request-1",
        sessionId: "session-1",
        askRequestId: "ask-1",
        response: { value: "PostgreSQL", cancelled: true },
      }),
    ).toThrow();
  });

  it("rejects empty non-abort commands", () => {
    expect(() =>
      BrowserCommandSchema.parse({
        type: "session_command",
        requestId: "prompt-1",
        sessionId: "session-1",
        command: "prompt",
        text: " ",
      }),
    ).toThrow();
  });
});

describe("push protocol", () => {
  const subscription = {
    endpoint: "https://push.example.test/send/device",
    keys: { p256dh: "A".repeat(87), auth: "A".repeat(22) },
  };
  it("accepts bounded registration and rejects unknown events", () => {
    expect(
      BrowserCommandSchema.parse({
        type: "push_subscription_register",
        requestId: "push-1",
        deviceId: "device-1",
        subscription,
        events: { inputRequired: true, sessionIdle: false },
      }),
    ).toMatchObject({ type: "push_subscription_register" });
    expect(() =>
      PushEventPreferencesSchema.parse({ inputRequired: true, sessionIdle: false, extra: true }),
    ).toThrow();
  });
  it("rejects non-HTTPS endpoints and malformed keys", () => {
    expect(() =>
      PushSubscriptionSchema.parse({ ...subscription, endpoint: "http://push.example.test" }),
    ).toThrow();
    expect(() =>
      PushSubscriptionSchema.parse({ ...subscription, keys: { ...subscription.keys, auth: "bad" } }),
    ).toThrow();
  });
});

describe("notification event protocol", () => {
  const event = {
    type: "notification_event" as const,
    event: "inputRequired" as const,
    title: "Input required" as const,
    body: "Build is waiting for input.",
    tag: "session-session-1-ask-ask-1",
    url: "/?session=session-1",
  };

  it("accepts the strict same-origin envelope", () => {
    expect(NotificationEventSchema.parse(event)).toEqual(event);
  });

  it.each(["https://remote.example/?session=session-1", "//remote.example/?session=session-1", "/\\remote"])(
    "rejects cross-origin notification paths: %s",
    (url) => {
      expect(() => NotificationEventSchema.parse({ ...event, url })).toThrow();
    },
  );

  it("rejects unknown fields and mismatched event text", () => {
    expect(() => NotificationEventSchema.parse({ ...event, extra: true })).toThrow();
    expect(() =>
      NotificationEventSchema.parse({ ...event, event: "sessionIdle", title: "Input required" }),
    ).toThrow();
  });

  it("rejects unbounded notification text and tags", () => {
    expect(() => NotificationEventSchema.parse({ ...event, body: "x".repeat(1_001) })).toThrow();
    expect(() => NotificationEventSchema.parse({ ...event, tag: "x".repeat(257) })).toThrow();
  });
});

describe("branch topology protocol", () => {
  it("accepts a strict ordered topology with parent relationships", () => {
    expect(
      SessionBranchTopologySchema.parse({
        sessionId: "session-1",
        currentBranch: "feature/child",
        branches: [
          { name: "main" },
          { name: "feature/parent", parent: "main" },
          { name: "feature/child", parent: "feature/parent" },
        ],
      }),
    ).toMatchObject({ currentBranch: "feature/child" });
  });

  it("admits multi-component refs longer than one filesystem path segment", () => {
    const branch = `feature/${"a".repeat(200)}/${"b".repeat(200)}`;
    expect(
      SessionBranchTopologySchema.parse({
        sessionId: "session-1",
        currentBranch: branch,
        branches: [{ name: "main" }, { name: branch, parent: "main" }],
      }).currentBranch,
    ).toBe(branch);
    expect(
      BrowserCommandSchema.parse({
        type: "switch_branch",
        requestId: "request-1",
        sessionId: "session-1",
        branch,
      }),
    ).toMatchObject({ branch });
    expect(() =>
      BrowserCommandSchema.parse({
        type: "switch_branch",
        requestId: "request-1",
        sessionId: "session-1",
        branch: "a".repeat(4_097),
      }),
    ).toThrow();
  });

  it("enforces the full branch-name limit in UTF-8 bytes", () => {
    const component = "é".repeat(120);
    const exactLimit = Array.from({ length: 17 }, () => component).join("/");
    const overLimit = [`a${component}`, ...Array.from({ length: 16 }, () => component)].join("/");
    expect(new TextEncoder().encode(exactLimit)).toHaveLength(4_096);
    expect(new TextEncoder().encode(overLimit)).toHaveLength(4_097);

    expect(
      BrowserCommandSchema.parse({
        type: "switch_branch",
        requestId: "request-1",
        sessionId: "session-1",
        branch: exactLimit,
      }),
    ).toMatchObject({ branch: exactLimit });
    expect(() =>
      BrowserCommandSchema.parse({
        type: "switch_branch",
        requestId: "request-1",
        sessionId: "session-1",
        branch: overLimit,
      }),
    ).toThrow();
  });

  it("rejects duplicate branch names", () => {
    expect(() =>
      SessionBranchTopologySchema.parse({
        sessionId: "session-1",
        currentBranch: "main",
        branches: [{ name: "main" }, { name: "main" }],
      }),
    ).toThrow();
  });

  it("rejects cyclic branch parent relationships", () => {
    expect(() =>
      SessionBranchTopologySchema.parse({
        sessionId: "session-1",
        currentBranch: "feature",
        branches: [{ name: "feature", parent: "feature" }],
      }),
    ).toThrow();
    expect(() =>
      SessionBranchTopologySchema.parse({
        sessionId: "session-1",
        currentBranch: "feature/one",
        branches: [
          { name: "feature/one", parent: "feature/two" },
          { name: "feature/two", parent: "feature/one" },
        ],
      }),
    ).toThrow();
  });

  it("rejects unknown parents and extra response fields", () => {
    expect(() =>
      SessionBranchTopologySchema.parse({
        sessionId: "session-1",
        currentBranch: "feature",
        branches: [{ name: "feature", parent: "missing" }],
      }),
    ).toThrow();
    expect(() =>
      SessionBranchTopologySchema.parse({
        sessionId: "session-1",
        currentBranch: "main",
        branches: [{ name: "main" }],
        extra: true,
      }),
    ).toThrow();
  });

  it("accepts and strictly validates switch_branch commands", () => {
    expect(
      BrowserCommandSchema.parse({
        type: "switch_branch",
        requestId: "request-1",
        sessionId: "session-1",
        branch: "feature/child",
      }),
    ).toEqual({
      type: "switch_branch",
      requestId: "request-1",
      sessionId: "session-1",
      branch: "feature/child",
    });
    expect(() =>
      BrowserCommandSchema.parse({
        type: "switch_branch",
        requestId: "request-1",
        sessionId: "session-1",
        branch: "--detach",
      }),
    ).toThrow();
    expect(() =>
      BrowserCommandSchema.parse({
        type: "switch_branch",
        requestId: "request-1",
        sessionId: "session-1",
        branch: "feature/child",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("report_application_error browser command and server frames", () => {
  it("accepts report_application_error with nested error object", () => {
    const command = {
      type: "report_application_error" as const,
      requestId: "report-1",
      error: {
        message: "UI component crashed",
        errorName: "TypeError",
        stack: "TypeError: Cannot read properties of undefined",
        context: { route: "/dashboard", componentName: "SessionViewer" },
      },
    };
    const parsed = BrowserCommandSchema.parse(command);
    expect(parsed).toEqual({
      type: "report_application_error",
      requestId: "report-1",
      error: {
        source: "browser",
        severity: "error",
        message: "UI component crashed",
        errorName: "TypeError",
        stack: "TypeError: Cannot read properties of undefined",
        context: { route: "/dashboard", componentName: "SessionViewer" },
      },
    });
  });

  it("accepts report_application_error with flat fields", () => {
    const command = {
      type: "report_application_error" as const,
      requestId: "report-2",
      message: "Direct flat error message",
      severity: "fatal" as const,
      errorName: "UnhandledException",
      context: { route: "/sessions", status: "failed" },
    };
    const parsed = BrowserCommandSchema.parse(command);
    expect(parsed).toEqual({
      type: "report_application_error",
      requestId: "report-2",
      source: "browser",
      severity: "fatal",
      message: "Direct flat error message",
      errorName: "UnhandledException",
      context: { route: "/sessions", status: "failed" },
    });
  });

  it("rejects browser reports attempting to spoof source as daemon", () => {
    expect(() =>
      BrowserCommandSchema.parse({
        type: "report_application_error",
        requestId: "report-spoof",
        error: {
          source: "daemon",
          message: "Spoofed error",
        },
      }),
    ).toThrow();

    expect(() =>
      BrowserCommandSchema.parse({
        type: "report_application_error",
        requestId: "report-spoof-flat",
        source: "daemon",
        message: "Spoofed error",
      }),
    ).toThrow();
  });

  it("rejects browser reports with unlisted/adversarial context keys", () => {
    expect(() =>
      BrowserCommandSchema.parse({
        type: "report_application_error",
        requestId: "report-bad-context",
        error: {
          message: "Error with bad context",
          context: { jwt: "secret-token" },
        },
      }),
    ).toThrow();
  });

  it("rejects empty message or extra fields on report_application_error", () => {
    expect(() =>
      BrowserCommandSchema.parse({
        type: "report_application_error",
        requestId: "report-empty",
        error: {
          message: "   ",
        },
      }),
    ).toThrow();

    expect(() =>
      BrowserCommandSchema.parse({
        type: "report_application_error",
        requestId: "report-extra",
        error: {
          message: "Valid message",
        },
        unexpected: 123,
      }),
    ).toThrow();
  });

  it("validates application_error_added frame through ServerFrameSchema", () => {
    const frame = {
      type: "application_error_added" as const,
      error: {
        id: "err-1",
        timestamp: "2026-08-16T12:00:00.000Z",
        source: "browser" as const,
        severity: "error" as const,
        message: "Render failure",
        context: { route: "/terminal" },
      },
    };
    expect(ServerFrameSchema.parse(frame)).toEqual(frame);
    expect(ApplicationErrorAddedFrameSchema.parse(frame)).toEqual(frame);
  });

  it("validates application_errors_cleared frame through ServerFrameSchema", () => {
    const frame = {
      type: "application_errors_cleared" as const,
      clearedAt: "2026-08-16T12:00:00.000Z",
      clearedCount: 5,
    };
    expect(ServerFrameSchema.parse(frame)).toEqual(frame);
    expect(ApplicationErrorsClearedFrameSchema.parse(frame)).toEqual(frame);

    const minimalFrame = {
      type: "application_errors_cleared" as const,
    };
    expect(ServerFrameSchema.parse(minimalFrame)).toEqual(minimalFrame);
  });
});
