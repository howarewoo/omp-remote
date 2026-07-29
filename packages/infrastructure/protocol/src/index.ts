import { z } from "zod";

export const SessionSourceSchema = z.enum(["rpc", "extension", "history"]);
export const SessionStatusSchema = z.enum(["idle", "running", "waiting", "disconnected", "history"]);
export const SessionCapabilitySchema = z.enum(["prompt", "steer", "follow_up", "abort", "resume"]);

export const TranscriptMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "tool", "system"]),
  text: z.string(),
  timestamp: z.string(),
  streaming: z.boolean(),
});

export const ActiveSubagentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lastActivity: z.string(),
});

export const SessionSchema = z.object({
  id: z.string().min(1),
  source: SessionSourceSchema,
  name: z.string().nullable(),
  cwd: z.string().min(1),
  status: SessionStatusSchema,
  connected: z.boolean(),
  model: z.string().nullable(),
  contextPercent: z.number().min(0).max(100).nullable(),
  lastActivity: z.string(),
  capabilities: z.array(SessionCapabilitySchema),
  messages: z.array(TranscriptMessageSchema),
  sessionPath: z.string().min(1).nullable(),
  activeSubagents: z.array(ActiveSubagentSchema).default([]),
});

export const SessionCatalogPageSchema = z.object({
  sessions: z.array(SessionSchema),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const SessionTranscriptResponseSchema = z.object({
  sessionId: z.string().min(1),
  messages: z.array(TranscriptMessageSchema),
});

const CommandTextSchema = z.string().trim().min(1).max(100_000);

export const BrowserCommandSchema = z.union([
  z.object({
    type: z.literal("launch"),
    requestId: z.string().min(1),
    cwd: z.string().trim().min(1),
    resume: z.string().trim().min(1).nullable(),
  }),
  z.object({
    type: z.literal("session_command"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    command: z.enum(["prompt", "steer", "follow_up"]),
    text: CommandTextSchema,
  }),
  z.object({
    type: z.literal("session_command"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    command: z.literal("abort"),
  }),
]);

export const ServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), sessions: z.array(SessionSchema) }),
  z.object({ type: z.literal("session_upsert"), session: SessionSchema }),
  z.object({
    type: z.literal("transcript_upsert"),
    sessionId: z.string().min(1),
    message: TranscriptMessageSchema,
  }),
  z.object({ type: z.literal("session_removed"), sessionId: z.string() }),
  z.object({
    type: z.literal("command_result"),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

const ExtensionRegistrationSessionSchema = SessionSchema.extend({
  sessionPath: SessionSchema.shape.sessionPath.default(null),
});

export const ExtensionRegisterSchema = z.object({
  type: z.literal("register"),
  session: ExtensionRegistrationSessionSchema,
});

export const ExtensionEventSchema = z.object({
  type: z.literal("event"),
  sessionId: z.string().min(1),
  event: z.enum(["agent_start", "agent_end", "message_start", "message_update", "message_end"]),
  message: TranscriptMessageSchema.nullable(),
  name: z.string().nullable(),
  model: z.string().nullable(),
  contextPercent: z.number().min(0).max(100).nullable(),
});

export const ExtensionHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  sessionId: z.string().min(1),
  name: z.string().nullable(),
  model: z.string().nullable(),
  contextPercent: z.number().min(0).max(100).nullable(),
  idle: z.boolean(),
});
export const ExtensionResultSchema = z.object({
  type: z.literal("command_result"),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
});

export const ExtensionFrameSchema = z.discriminatedUnion("type", [
  ExtensionRegisterSchema,
  ExtensionEventSchema,
  ExtensionHeartbeatSchema,
  ExtensionResultSchema,
]);

export const ExtensionCommandSchema = z.discriminatedUnion("command", [
  z.object({
    requestId: z.string(),
    command: z.enum(["prompt", "steer", "follow_up"]),
    text: CommandTextSchema,
  }),
  z.object({ requestId: z.string(), command: z.literal("abort") }),
]);

export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;
export type ActiveSubagent = z.infer<typeof ActiveSubagentSchema>;
export type ExtensionCommand = z.infer<typeof ExtensionCommandSchema>;
export type ExtensionFrame = z.infer<typeof ExtensionFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type SessionCatalogPage = z.infer<typeof SessionCatalogPageSchema>;
export type SessionTranscriptResponse = z.infer<typeof SessionTranscriptResponseSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type SessionCapability = z.infer<typeof SessionCapabilitySchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;
