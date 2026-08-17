import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createLogger, type ErrorLogEntry } from "./index.js";

describe("createLogger", () => {
  let stdoutSpy: MockInstance;
  let stderrSpy: MockInstance;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("writes info logs to stdout with standard fields", () => {
    const logger = createLogger("daemon-test");
    logger.info("session started", { sessionId: "s-123", count: 1 });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).not.toHaveBeenCalled();

    const firstStdoutCall = stdoutSpy.mock.calls[0]?.[0];
    expect(typeof firstStdoutCall).toBe("string");
    const output = JSON.parse(String(firstStdoutCall));
    expect(output).toMatchObject({
      level: "info",
      service: "daemon-test",
      message: "session started",
      sessionId: "s-123",
      count: 1,
    });
    expect(typeof output.timestamp).toBe("string");
  });

  it("writes warn logs to stderr without calling observer", () => {
    const observer = vi.fn((_entry: ErrorLogEntry) => undefined);
    const logger = createLogger("daemon-test", { onError: observer });
    logger.warn("high memory usage", { memoryMb: 500 });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(observer).not.toHaveBeenCalled();

    const firstStderrCall = stderrSpy.mock.calls[0]?.[0];
    expect(typeof firstStderrCall).toBe("string");
    const output = JSON.parse(String(firstStderrCall));
    expect(output).toMatchObject({
      level: "warn",
      service: "daemon-test",
      message: "high memory usage",
      memoryMb: 500,
    });
  });

  it("writes error logs to stderr and invokes error observer with structured entry, ensuring stderr precedes observer", () => {
    const executionOrder: string[] = [];
    stderrSpy.mockImplementation(() => {
      executionOrder.push("stderr");
      return true;
    });

    const observer = vi.fn((_entry: ErrorLogEntry) => {
      executionOrder.push("observer");
    });
    const logger = createLogger("daemon-test", { onError: observer });
    const error = new Error("Connection failed");

    logger.error("rpc disconnect", error, { peerId: "peer-1" });

    // Assert stderr mock invocation order precedes observer invocation
    expect(executionOrder).toEqual(["stderr", "observer"]);

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(1);

    const firstStderrCall = stderrSpy.mock.calls[0]?.[0];
    expect(typeof firstStderrCall).toBe("string");
    const stderrOutput = JSON.parse(String(firstStderrCall));
    expect(stderrOutput).toMatchObject({
      level: "error",
      service: "daemon-test",
      message: "rpc disconnect",
      peerId: "peer-1",
      error: { name: "Error", message: "Connection failed" },
    });

    const observerEntry = observer.mock.calls[0]?.[0];
    expect(observerEntry).toBeDefined();
    if (!observerEntry) throw new Error("Expected observer entry");

    expect(observerEntry).toMatchObject({
      level: "error",
      service: "daemon-test",
      message: "rpc disconnect",
      fields: { peerId: "peer-1" },
      rawError: error,
    });
    expect(observerEntry.error.name).toBe("Error");
    expect(observerEntry.error.message).toBe("Connection failed");
    expect(typeof observerEntry.error.stack).toBe("string");
  });

  it("supports passing observer directly as a function argument", () => {
    const observer = vi.fn((_entry: ErrorLogEntry) => undefined);
    const logger = createLogger("daemon-test", observer);
    logger.error("crash", "string error");

    expect(observer).toHaveBeenCalledTimes(1);
    const entry = observer.mock.calls[0]?.[0];
    expect(entry).toBeDefined();
    if (!entry) throw new Error("Expected observer entry");

    expect(entry.message).toBe("crash");
    expect(entry.error.message).toBe("string error");
  });

  it("preserves structured stderr write even if observer throws synchronously", () => {
    const observer = vi.fn((_entry: ErrorLogEntry) => {
      throw new Error("Observer threw synchronously");
    });
    const logger = createLogger("daemon-test", { onError: observer });

    expect(() => {
      logger.error("critical failure", new Error("disk full"));
    }).not.toThrow();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(1);

    const firstStderrCall = stderrSpy.mock.calls[0]?.[0];
    expect(typeof firstStderrCall).toBe("string");
    const output = JSON.parse(String(firstStderrCall));
    expect(output.message).toBe("critical failure");
  });

  it("handles async observer rejections without throwing or unhandled rejections", async () => {
    const observer = vi.fn(async (_entry: ErrorLogEntry) => {
      throw new Error("Observer async rejection");
    });
    const logger = createLogger("daemon-test", { onError: observer });

    expect(() => {
      logger.error("async failure", new Error("timeout"));
    }).not.toThrow();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(1);
  });
});
