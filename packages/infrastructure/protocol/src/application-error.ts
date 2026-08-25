import { z } from "zod";
import { utf8Encoder } from "./utf8.js";
export const APPLICATION_ERROR_MAX_RECORDS = 1_000;
export const APPLICATION_ERROR_MAX_BYTES = 5 * 1024 * 1024;
export const APPLICATION_ERROR_MESSAGE_MAX_CHARS = 4_096;
export const APPLICATION_ERROR_STACK_MAX_CHARS = 32_768;
export const APPLICATION_ERROR_NAME_MAX_CHARS = 256;
export const APPLICATION_ERROR_CONTEXT_VALUE_MAX_CHARS = 1_024;

export const APPLICATION_ERROR_SAFE_CONTEXT_KEYS = [
  "action",
  "agentId",
  "attempt",
  "branch",
  "clientId",
  "code",
  "column",
  "component",
  "componentName",
  "connectionId",
  "count",
  "cwd",
  "deviceId",
  "durationMs",
  "errorCode",
  "event",
  "filePath",
  "line",
  "method",
  "module",
  "operation",
  "parentSessionId",
  "path",
  "pathname",
  "peerId",
  "phase",
  "platform",
  "protocolVersion",
  "queryId",
  "requestId",
  "retryCount",
  "route",
  "runtime",
  "service",
  "sessionId",
  "source",
  "status",
  "statusCode",
  "timeoutMs",
  "version",
  "workingDirectory",
] as const;

export type ApplicationErrorSafeContextKey = (typeof APPLICATION_ERROR_SAFE_CONTEXT_KEYS)[number];

const SAFE_CONTEXT_KEYS: Record<string, true> = Object.fromEntries(
  APPLICATION_ERROR_SAFE_CONTEXT_KEYS.map((key) => [key, true]),
);

export function isSafeContextKey(key: string): key is ApplicationErrorSafeContextKey {
  return SAFE_CONTEXT_KEYS[key] === true;
}

export const ApplicationErrorSeveritySchema = z.enum(["error", "fatal"]);
export type ApplicationErrorSeverity = z.infer<typeof ApplicationErrorSeveritySchema>;

export const ApplicationErrorSourceSchema = z.enum(["daemon", "browser"]);
export type ApplicationErrorSource = z.infer<typeof ApplicationErrorSourceSchema>;

export const ApplicationErrorContextKeySchema = z.enum(APPLICATION_ERROR_SAFE_CONTEXT_KEYS);

export const ApplicationErrorContextValueSchema = z.union([
  z.string().max(APPLICATION_ERROR_CONTEXT_VALUE_MAX_CHARS),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type ApplicationErrorContextValue = z.infer<typeof ApplicationErrorContextValueSchema>;

export const ApplicationErrorContextSchema = z.partialRecord(
  ApplicationErrorContextKeySchema,
  ApplicationErrorContextValueSchema,
);
export type ApplicationErrorContext = z.infer<typeof ApplicationErrorContextSchema>;

export function sanitizeApplicationErrorContext(
  context?: Record<string, unknown> | null,
): ApplicationErrorContext | undefined {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return undefined;
  }
  const result: ApplicationErrorContext = {};
  for (const [key, value] of Object.entries(context)) {
    const trimmedKey = key.trim();
    if (!isSafeContextKey(trimmedKey)) {
      continue;
    }
    if (value === null || typeof value === "boolean") {
      result[trimmedKey] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[trimmedKey] = value;
    } else if (typeof value === "string") {
      result[trimmedKey] = value.slice(0, APPLICATION_ERROR_CONTEXT_VALUE_MAX_CHARS);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export const ApplicationErrorInputSchema = z
  .object({
    id: z.string().trim().min(1).max(128).optional(),
    timestamp: z.string().datetime().optional(),
    source: ApplicationErrorSourceSchema,
    severity: ApplicationErrorSeveritySchema.default("error"),
    message: z.string().trim().min(1).max(APPLICATION_ERROR_MESSAGE_MAX_CHARS),
    errorName: z.string().trim().min(1).max(APPLICATION_ERROR_NAME_MAX_CHARS).optional(),
    stack: z.string().max(APPLICATION_ERROR_STACK_MAX_CHARS).optional(),
    context: ApplicationErrorContextSchema.optional(),
  })
  .strict();
export type ApplicationErrorInput = z.infer<typeof ApplicationErrorInputSchema>;

export const ApplicationErrorRecordSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    timestamp: z.string().datetime(),
    source: ApplicationErrorSourceSchema,
    severity: ApplicationErrorSeveritySchema,
    message: z.string().trim().min(1).max(APPLICATION_ERROR_MESSAGE_MAX_CHARS),
    errorName: z.string().trim().min(1).max(APPLICATION_ERROR_NAME_MAX_CHARS).optional(),
    stack: z.string().max(APPLICATION_ERROR_STACK_MAX_CHARS).optional(),
    context: ApplicationErrorContextSchema.optional(),
  })
  .strict();
export type ApplicationErrorRecord = z.infer<typeof ApplicationErrorRecordSchema>;

export const ApplicationErrorStorageStatusSchema = z.enum(["healthy", "degraded"]);
export type ApplicationErrorStorageStatus = z.infer<typeof ApplicationErrorStorageStatusSchema>;

export const ApplicationErrorStorageHealthSchema = z
  .object({
    status: ApplicationErrorStorageStatusSchema,
    recordCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    oldestTimestamp: z.string().datetime().nullable(),
    newestTimestamp: z.string().datetime().nullable(),
    degradedReason: z.string().max(1_024).nullable().optional(),
  })
  .strict();
export type ApplicationErrorStorageHealth = z.infer<typeof ApplicationErrorStorageHealthSchema>;

export const ApplicationErrorLedgerResponseSchema = z
  .object({
    errors: z.array(ApplicationErrorRecordSchema).max(APPLICATION_ERROR_MAX_RECORDS),
    health: ApplicationErrorStorageHealthSchema,
  })
  .strict();
export type ApplicationErrorLedgerResponse = z.infer<typeof ApplicationErrorLedgerResponseSchema>;

export const PersistedApplicationErrorsStateSchema = z
  .object({
    version: z.literal(1),
    errors: z.array(ApplicationErrorRecordSchema).max(APPLICATION_ERROR_MAX_RECORDS),
  })
  .strict();
export type PersistedApplicationErrorsState = z.infer<typeof PersistedApplicationErrorsStateSchema>;
export function boundApplicationErrorRecords(
  records: readonly ApplicationErrorRecord[],
  maxRecords: number = APPLICATION_ERROR_MAX_RECORDS,
  maxBytes: number = APPLICATION_ERROR_MAX_BYTES,
): ApplicationErrorRecord[] {
  let bounded = records.length > maxRecords ? records.slice(records.length - maxRecords) : [...records];
  while (bounded.length > 0) {
    const serialized = `${JSON.stringify({ version: 1, errors: bounded }, null, 2)}\n`;
    const byteLength = utf8Encoder.encode(serialized).byteLength;
    if (byteLength <= maxBytes) {
      break;
    }
    bounded.shift();
  }
  return bounded;
}
export const ReportApplicationErrorCommandSchema = z.union([
  z
    .object({
      type: z.literal("report_application_error"),
      requestId: z.string().min(1),
      error: ApplicationErrorInputSchema.extend({
        source: z.literal("browser").default("browser"),
      }),
    })
    .strict(),
  z
    .object({
      type: z.literal("report_application_error"),
      requestId: z.string().min(1),
      source: z.literal("browser").default("browser"),
      severity: ApplicationErrorSeveritySchema.default("error"),
      message: z.string().trim().min(1).max(APPLICATION_ERROR_MESSAGE_MAX_CHARS),
      errorName: z.string().trim().min(1).max(APPLICATION_ERROR_NAME_MAX_CHARS).optional(),
      stack: z.string().max(APPLICATION_ERROR_STACK_MAX_CHARS).optional(),
      context: ApplicationErrorContextSchema.optional(),
      id: z.string().trim().min(1).max(128).optional(),
      timestamp: z.string().datetime().optional(),
    })
    .strict(),
]);
export type ReportApplicationErrorCommand = z.infer<typeof ReportApplicationErrorCommandSchema>;

export const ApplicationErrorAddedFrameSchema = z
  .object({
    type: z.literal("application_error_added"),
    error: ApplicationErrorRecordSchema,
  })
  .strict();
export type ApplicationErrorAddedFrame = z.infer<typeof ApplicationErrorAddedFrameSchema>;

export const ApplicationErrorsClearedFrameSchema = z
  .object({
    type: z.literal("application_errors_cleared"),
    clearedAt: z.string().datetime().optional(),
    clearedCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ApplicationErrorsClearedFrame = z.infer<typeof ApplicationErrorsClearedFrameSchema>;
