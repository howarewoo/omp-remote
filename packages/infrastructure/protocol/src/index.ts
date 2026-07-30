import { z } from "zod";

export const SessionSourceSchema = z.enum(["rpc", "extension", "history"]);
export const SessionStatusSchema = z.enum(["idle", "running", "waiting", "disconnected", "history"]);
export const SessionCapabilitySchema = z.enum([
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "kill",
  "resume",
  "model",
  "effort",
]);

export const EffortSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const SessionModelOptionSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  efforts: z.array(EffortSchema),
});
export const TranscriptPresentationSchema = z.enum(["text", "diff"]);

export const TranscriptMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "tool", "system"]),
  text: z.string(),
  timestamp: z.string(),
  streaming: z.boolean(),
  presentation: TranscriptPresentationSchema.default("text"),
  toolName: z.string().min(1).optional(),
});

export const ActiveSubagentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lastActivity: z.string(),
});

export const SkillCommandSchema = z.object({
  name: z.string().regex(/^skill:[^\s]+$/),
  description: z.string().trim().min(1).optional(),
});

export const AskRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
    kind: z.enum(["select", "text"]),
    title: z.string().min(1),
    options: z.array(z.string()).default([]),
    initialValue: z.string().nullable().default(null),
    expiresAt: z.string().nullable().default(null),
  })
  .strict();

export const AskResponseSchema = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ cancelled: z.literal(true), timedOut: z.boolean().optional() }).strict(),
]);

export const SessionSchema = z.object({
  id: z.string().min(1),
  source: SessionSourceSchema,
  name: z.string().nullable(),
  cwd: z.string().min(1),
  branch: z.string().min(1).nullable().default(null),
  status: SessionStatusSchema,
  connected: z.boolean(),
  model: z.string().nullable(),
  effort: EffortSchema.nullable().optional(),
  availableModels: z.array(SessionModelOptionSchema).optional(),
  contextPercent: z.number().min(0).max(100).nullable(),
  createdAt: z.string(),
  lastActivity: z.string(),
  capabilities: z.array(SessionCapabilitySchema),
  messages: z.array(TranscriptMessageSchema),
  sessionPath: z.string().min(1).nullable(),
  activeSubagents: z.array(ActiveSubagentSchema).default([]),
  skillCommands: z.array(SkillCommandSchema).default([]),
});

export const SessionPatchSchema = SessionSchema.omit({ id: true, messages: true })
  .partial()
  .extend({
    branch: SessionSchema.shape.branch.unwrap().optional(),
    activeSubagents: SessionSchema.shape.activeSubagents.unwrap().optional(),
    skillCommands: SessionSchema.shape.skillCommands.unwrap().optional(),
  })
  .strict();

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
  z.object({
    type: z.literal("session_command"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    command: z.literal("kill"),
  }),
  z.object({
    type: z.literal("session_command"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    command: z.literal("set_model"),
    model: z.string().regex(/^[^/]+\/.+$/),
  }),
  z.object({
    type: z.literal("session_command"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    command: z.literal("set_effort"),
    effort: EffortSchema,
  }),
  z
    .object({
      type: z.literal("ask_response"),
      requestId: z.string().min(1),
      sessionId: z.string().min(1),
      askRequestId: z.string().min(1),
      response: AskResponseSchema,
    })
    .strict(),
]);

export const ServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    sessions: z.array(SessionSchema),
    askRequests: z.array(AskRequestSchema).default([]),
  }),
  z.object({ type: z.literal("session_upsert"), session: SessionSchema }),
  z.object({
    type: z.literal("session_update"),
    sessionId: z.string().min(1),
    patch: SessionPatchSchema,
  }),
  z.object({
    type: z.literal("transcript_upsert"),
    sessionId: z.string().min(1),
    message: TranscriptMessageSchema,
  }),
  z.object({ type: z.literal("ask_request"), request: AskRequestSchema }),
  z.object({
    type: z.literal("ask_cancelled"),
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
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
  createdAt: SessionSchema.shape.createdAt.optional(),
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
  effort: EffortSchema.nullable().optional(),
});

export const ExtensionHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  sessionId: z.string().min(1),
  name: z.string().nullable(),
  model: z.string().nullable(),
  contextPercent: z.number().min(0).max(100).nullable(),
  effort: EffortSchema.nullable().optional(),
  availableModels: z.array(SessionModelOptionSchema).optional(),
  idle: z.boolean(),
  skillCommands: z.array(SkillCommandSchema).optional(),
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
  z.object({
    requestId: z.string(),
    command: z.literal("set_model"),
    model: z.string().regex(/^[^/]+\/.+$/),
  }),
  z.object({ requestId: z.string(), command: z.literal("set_effort"), effort: EffortSchema }),
]);

export type AskRequest = z.infer<typeof AskRequestSchema>;
export type AskResponse = z.infer<typeof AskResponseSchema>;
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;
export type Effort = z.infer<typeof EffortSchema>;
export type ActiveSubagent = z.infer<typeof ActiveSubagentSchema>;
export type ExtensionCommand = z.infer<typeof ExtensionCommandSchema>;
export type ExtensionFrame = z.infer<typeof ExtensionFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type SessionCatalogPage = z.infer<typeof SessionCatalogPageSchema>;
export type SessionTranscriptResponse = z.infer<typeof SessionTranscriptResponseSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type SessionModelOption = z.infer<typeof SessionModelOptionSchema>;
export type SessionPatch = z.infer<typeof SessionPatchSchema>;
export type SessionCapability = z.infer<typeof SessionCapabilitySchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SkillCommand = z.infer<typeof SkillCommandSchema>;
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;

export function compareSessionsByCreation(left: Session, right: Session): number {
  return right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}

export function getMainSessionIds(sessions: readonly Session[]): Set<string> {
  const mainSessionIds = new Set<string>();
  const subagentIds = new Set<string>();
  const sessionPaths = new Set<string>();

  for (const session of sessions) {
    mainSessionIds.add(session.id);
    if (session.sessionPath?.endsWith(".jsonl")) sessionPaths.add(session.sessionPath);
    for (const subagent of session.activeSubagents) subagentIds.add(subagent.id);
  }
  for (const subagentId of subagentIds) mainSessionIds.delete(subagentId);
  for (const session of sessions) {
    if (hasSessionPathAncestor(session.sessionPath, sessionPaths)) mainSessionIds.delete(session.id);
  }

  return mainSessionIds;
}

export function filterMainSessions(sessions: readonly Session[]): Session[] {
  const mainSessionIds = getMainSessionIds(sessions);
  return sessions.filter((session) => mainSessionIds.has(session.id));
}

function hasSessionPathAncestor(sessionPath: string | null, sessionPaths: ReadonlySet<string>): boolean {
  if (!sessionPath?.endsWith(".jsonl")) return false;

  let separatorIndex = sessionPath.lastIndexOf("/");
  while (separatorIndex > 0) {
    if (sessionPaths.has(`${sessionPath.slice(0, separatorIndex)}.jsonl`)) return true;
    separatorIndex = sessionPath.lastIndexOf("/", separatorIndex - 1);
  }
  return false;
}
