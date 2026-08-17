import { describe, expect, it } from "vitest";
import {
  APPLICATION_ERROR_CONTEXT_VALUE_MAX_CHARS,
  APPLICATION_ERROR_MAX_BYTES,
  APPLICATION_ERROR_MAX_RECORDS,
  APPLICATION_ERROR_MESSAGE_MAX_CHARS,
  APPLICATION_ERROR_NAME_MAX_CHARS,
  APPLICATION_ERROR_SAFE_CONTEXT_KEYS,
  APPLICATION_ERROR_STACK_MAX_CHARS,
  ApplicationErrorContextKeySchema,
  ApplicationErrorContextSchema,
  ApplicationErrorInputSchema,
  ApplicationErrorLedgerResponseSchema,
  type ApplicationErrorRecord,
  ApplicationErrorRecordSchema,
  ApplicationErrorSeveritySchema,
  ApplicationErrorSourceSchema,
  ApplicationErrorStorageHealthSchema,
  boundApplicationErrorRecords,
  isSafeContextKey,
  PersistedApplicationErrorsStateSchema,
  sanitizeApplicationErrorContext,
} from "./index.js";

describe("ApplicationError protocol schemas", () => {
  describe("severity and source schemas", () => {
    it("accepts supported severities", () => {
      expect(ApplicationErrorSeveritySchema.parse("error")).toBe("error");
      expect(ApplicationErrorSeveritySchema.parse("fatal")).toBe("fatal");
    });

    it("rejects unsupported severities", () => {
      expect(() => ApplicationErrorSeveritySchema.parse("info")).toThrow();
      expect(() => ApplicationErrorSeveritySchema.parse("warn")).toThrow();
      expect(() => ApplicationErrorSeveritySchema.parse("critical")).toThrow();
    });

    it("accepts supported sources", () => {
      expect(ApplicationErrorSourceSchema.parse("daemon")).toBe("daemon");
      expect(ApplicationErrorSourceSchema.parse("browser")).toBe("browser");
    });

    it("rejects unsupported sources", () => {
      expect(() => ApplicationErrorSourceSchema.parse("cli")).toThrow();
      expect(() => ApplicationErrorSourceSchema.parse("server")).toThrow();
    });
  });

  describe("safe context key allowlist and adversarial key rejection", () => {
    it("accepts all explicitly allowlisted operational metadata keys", () => {
      for (const key of APPLICATION_ERROR_SAFE_CONTEXT_KEYS) {
        expect(isSafeContextKey(key)).toBe(true);
        expect(ApplicationErrorContextKeySchema.parse(key)).toBe(key);
      }
    });

    it.each([
      "jwt",
      "token",
      "accessToken",
      "access_token",
      "refreshToken",
      "refresh_token",
      "secret",
      "clientSecret",
      "client_secret",
      "password",
      "passwd",
      "auth",
      "authorization",
      "apiKey",
      "api_key",
      "api-key",
      "credential",
      "credentials",
      "privateKey",
      "private_key",
      "cookie",
      "set_cookie",
      "bearer",
      "sessionToken",
      "session_token",
      "user_email",
      "userPassword",
      "ssn",
      "creditCard",
      "payload",
      "data",
      "headers",
      "custom_arbitrary_key",
      "unknownField",
    ])("rejects unlisted/adversarial key %s", (key) => {
      expect(isSafeContextKey(key)).toBe(false);
      expect(() => ApplicationErrorContextKeySchema.parse(key)).toThrow();
      expect(() => ApplicationErrorContextSchema.parse({ [key]: "value" })).toThrow();
    });

    it("accepts allowlisted primitive context values with allowed keys", () => {
      const context = {
        route: "/sessions/overview",
        code: "ECONNREFUSED",
        retryCount: 42,
        status: "failed",
        action: null,
      };
      expect(ApplicationErrorContextSchema.parse(context)).toEqual(context);
    });

    it("rejects non-allowlisted context values even with valid keys", () => {
      expect(() => ApplicationErrorContextSchema.parse({ route: [1, 2, 3] })).toThrow();
      expect(() => ApplicationErrorContextSchema.parse({ route: { nested: true } })).toThrow();
      expect(() => ApplicationErrorContextSchema.parse({ route: undefined })).toThrow();
      expect(() => ApplicationErrorContextSchema.parse({ count: Number.NaN })).toThrow();
      expect(() => ApplicationErrorContextSchema.parse({ count: Number.POSITIVE_INFINITY })).toThrow();
    });

    it("rejects oversized string context values", () => {
      const longValue = "x".repeat(APPLICATION_ERROR_CONTEXT_VALUE_MAX_CHARS + 1);
      expect(() => ApplicationErrorContextSchema.parse({ route: longValue })).toThrow();
    });

    it("sanitizes context by dropping all unlisted/adversarial keys and truncating long strings", () => {
      const raw = {
        route: "/dashboard",
        jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        authToken: "secret-token",
        password: "123",
        count: 10,
        action: null,
        empty: null,
        nested: { inner: "drop" },
        list: [1, 2],
        customUnknown: "drop me",
        path: "y".repeat(APPLICATION_ERROR_CONTEXT_VALUE_MAX_CHARS + 100),
      };
      const sanitized = sanitizeApplicationErrorContext(raw);
      expect(sanitized).toEqual({
        route: "/dashboard",
        count: 10,
        action: null,
        path: "y".repeat(APPLICATION_ERROR_CONTEXT_VALUE_MAX_CHARS),
      });
      expect(sanitized).not.toHaveProperty("jwt");
      expect(sanitized).not.toHaveProperty("authToken");
      expect(sanitized).not.toHaveProperty("password");
      expect(sanitized).not.toHaveProperty("empty");
      expect(sanitized).not.toHaveProperty("nested");
      expect(sanitized).not.toHaveProperty("list");
      expect(sanitized).not.toHaveProperty("customUnknown");
    });

    it("returns undefined when sanitizing empty or non-object contexts", () => {
      expect(sanitizeApplicationErrorContext(null)).toBeUndefined();
      expect(sanitizeApplicationErrorContext(undefined)).toBeUndefined();
      expect(sanitizeApplicationErrorContext({})).toBeUndefined();
      expect(sanitizeApplicationErrorContext({ jwt: "token" })).toBeUndefined();
      expect(sanitizeApplicationErrorContext({ unlistedKey: "value" })).toBeUndefined();
    });
  });

  describe("ApplicationErrorInputSchema", () => {
    it("accepts minimal input and defaults severity to error", () => {
      const parsed = ApplicationErrorInputSchema.parse({
        source: "daemon",
        message: "Failed to bind port",
      });
      expect(parsed.source).toBe("daemon");
      expect(parsed.severity).toBe("error");
      expect(parsed.message).toBe("Failed to bind port");
      expect(parsed.id).toBeUndefined();
      expect(parsed.timestamp).toBeUndefined();
    });

    it("accepts full input with fatal severity, errorName, stack, and context", () => {
      const input = {
        id: "err-123",
        timestamp: "2026-08-16T12:00:00.000Z",
        source: "browser" as const,
        severity: "fatal" as const,
        message: "Uncaught UI panic",
        errorName: "TypeError",
        stack: "TypeError: Cannot read properties of undefined\n    at render (app.js:10:5)",
        context: { route: "/sessions", retryCount: 3 },
      };
      expect(ApplicationErrorInputSchema.parse(input)).toEqual(input);
    });

    it("rejects unknown extra properties", () => {
      expect(() =>
        ApplicationErrorInputSchema.parse({
          source: "daemon",
          message: "test",
          extraField: 123,
        }),
      ).toThrow();
    });

    it("enforces string length bounds on input fields", () => {
      expect(() =>
        ApplicationErrorInputSchema.parse({
          source: "daemon",
          message: "m".repeat(APPLICATION_ERROR_MESSAGE_MAX_CHARS + 1),
        }),
      ).toThrow();

      expect(() =>
        ApplicationErrorInputSchema.parse({
          source: "daemon",
          message: "valid",
          errorName: "e".repeat(APPLICATION_ERROR_NAME_MAX_CHARS + 1),
        }),
      ).toThrow();

      expect(() =>
        ApplicationErrorInputSchema.parse({
          source: "daemon",
          message: "valid",
          stack: "s".repeat(APPLICATION_ERROR_STACK_MAX_CHARS + 1),
        }),
      ).toThrow();
    });
  });

  describe("ApplicationErrorRecordSchema", () => {
    it("validates a full error record", () => {
      const record: ApplicationErrorRecord = {
        id: "err-uuid-1",
        timestamp: "2026-08-16T12:00:00.000Z",
        source: "daemon",
        severity: "error",
        message: "RPC connection dropped",
        errorName: "ConnectionError",
        stack: "ConnectionError: stream ended\n    at client.ts:50",
        context: { peerId: "peer-99", attempt: 1 },
      };
      expect(ApplicationErrorRecordSchema.parse(record)).toEqual(record);
    });

    it("rejects records missing required fields", () => {
      expect(() =>
        ApplicationErrorRecordSchema.parse({
          timestamp: "2026-08-16T12:00:00.000Z",
          source: "daemon",
          severity: "error",
          message: "msg",
        }),
      ).toThrow();

      expect(() =>
        ApplicationErrorRecordSchema.parse({
          id: "1",
          source: "daemon",
          severity: "error",
          message: "msg",
        }),
      ).toThrow();
    });

    it("rejects records with invalid timestamp", () => {
      expect(() =>
        ApplicationErrorRecordSchema.parse({
          id: "1",
          timestamp: "not-a-date",
          source: "daemon",
          severity: "error",
          message: "msg",
        }),
      ).toThrow();
    });
  });

  describe("Storage health and ledger response schemas", () => {
    it("validates healthy storage health", () => {
      const health = {
        status: "healthy" as const,
        recordCount: 5,
        totalBytes: 1024,
        oldestTimestamp: "2026-08-16T10:00:00.000Z",
        newestTimestamp: "2026-08-16T12:00:00.000Z",
        degradedReason: null,
      };
      expect(ApplicationErrorStorageHealthSchema.parse(health)).toEqual(health);
    });

    it("validates degraded storage health with reason", () => {
      const health = {
        status: "degraded" as const,
        recordCount: 0,
        totalBytes: 0,
        oldestTimestamp: null,
        newestTimestamp: null,
        degradedReason: "Corrupted storage file",
      };
      expect(ApplicationErrorStorageHealthSchema.parse(health)).toEqual(health);
    });

    it("validates ledger response schema and enforces max 1000 records cap", () => {
      const makeRecord = (index: number): ApplicationErrorRecord => ({
        id: `err-${index}`,
        timestamp: "2026-08-16T12:00:00.000Z",
        source: "daemon",
        severity: "error",
        message: `msg-${index}`,
      });

      const responseAt1000 = {
        errors: Array.from({ length: APPLICATION_ERROR_MAX_RECORDS }, (_, i) => makeRecord(i)),
        health: {
          status: "healthy" as const,
          recordCount: APPLICATION_ERROR_MAX_RECORDS,
          totalBytes: 250000,
          oldestTimestamp: "2026-08-16T12:00:00.000Z",
          newestTimestamp: "2026-08-16T12:00:00.000Z",
          degradedReason: null,
        },
      };
      expect(ApplicationErrorLedgerResponseSchema.parse(responseAt1000)).toEqual(responseAt1000);

      // Rejects 1001 records (> 1000)
      const responseAt1001 = {
        ...responseAt1000,
        errors: Array.from({ length: APPLICATION_ERROR_MAX_RECORDS + 1 }, (_, i) => makeRecord(i)),
      };
      expect(() => ApplicationErrorLedgerResponseSchema.parse(responseAt1001)).toThrow();
    });

    it("validates persisted state schema and enforces max 1000 records cap", () => {
      const makeRecord = (index: number): ApplicationErrorRecord => ({
        id: `err-${index}`,
        timestamp: "2026-08-16T12:00:00.000Z",
        source: "daemon",
        severity: "error",
        message: `err-${index}`,
      });

      const stateAt1000 = {
        version: 1 as const,
        errors: Array.from({ length: APPLICATION_ERROR_MAX_RECORDS }, (_, i) => makeRecord(i)),
      };
      expect(PersistedApplicationErrorsStateSchema.parse(stateAt1000)).toEqual(stateAt1000);

      // Rejects 1001 records (> 1000)
      const stateAt1001 = {
        version: 1 as const,
        errors: Array.from({ length: APPLICATION_ERROR_MAX_RECORDS + 1 }, (_, i) => makeRecord(i)),
      };
      expect(() => PersistedApplicationErrorsStateSchema.parse(stateAt1001)).toThrow();
    });
  });

  describe("boundApplicationErrorRecords helper", () => {
    function makeRecord(id: string, message: string): ApplicationErrorRecord {
      return {
        id,
        timestamp: "2026-08-16T12:00:00.000Z",
        source: "daemon",
        severity: "error",
        message,
      };
    }

    it("evicts oldest records when count exceeds maxRecords", () => {
      const records = [makeRecord("1", "one"), makeRecord("2", "two"), makeRecord("3", "three")];
      const bounded = boundApplicationErrorRecords(records, 2, 1_000_000);
      expect(bounded.map((r) => r.id)).toEqual(["2", "3"]);
    });

    it("evicts oldest records when byte size exceeds maxBytes", () => {
      const records = [
        makeRecord("1", "a".repeat(100)),
        makeRecord("2", "b".repeat(100)),
        makeRecord("3", "c".repeat(100)),
      ];
      const fullSize = new TextEncoder().encode(
        `${JSON.stringify({ version: 1, errors: records }, null, 2)}\n`,
      ).byteLength;
      const bounded = boundApplicationErrorRecords(records, 10, fullSize - 50);
      expect(bounded.map((r) => r.id)).toEqual(["2", "3"]);
    });

    it("handles multi-byte UTF-8 characters accurately", () => {
      const records = [makeRecord("1", "🔥".repeat(50)), makeRecord("2", "✨".repeat(50))];
      const bounded = boundApplicationErrorRecords(records, 10, 300);
      expect(bounded.length).toBeLessThanOrEqual(1);
    });
  });
});
