import { describe, expect, it } from "vitest";
import { BrowserCommandSchema } from "./index.js";

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
