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
export const RoleEffortSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
  "inherit",
]);
export const SessionModelOptionSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  efforts: z.array(EffortSchema),
  roles: z.array(z.string().min(1)).optional(),
  roleEfforts: z.record(z.string().min(1), RoleEffortSchema).optional(),
});
export const TranscriptPresentationSchema = z.enum(["text", "diff"]);

export const TRANSCRIPT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const TRANSCRIPT_IMAGE_SESSION_MAX_BYTES = 50 * 1024 * 1024;

export const TranscriptImageMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
export const TranscriptImageUnavailableReasonSchema = z.enum([
  "invalid_reference",
  "missing",
  "unsupported_mime",
  "mime_mismatch",
  "oversized",
  "budget_exceeded",
]);
export type TranscriptImageUnavailableReason = z.infer<typeof TranscriptImageUnavailableReasonSchema>;

function isTranscriptImageBase64Alphabet(data: string): boolean {
  let paddingStarted = false;
  let paddingCount = 0;
  for (const character of data) {
    if (character === "=") {
      paddingStarted = true;
      paddingCount += 1;
      continue;
    }
    const code = character.charCodeAt(0);
    const isAlphabetCharacter =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      character === "+" ||
      character === "/";
    if (paddingStarted || !isAlphabetCharacter) return false;
  }
  return paddingCount <= 2;
}

export function getTranscriptImageBase64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

const TranscriptImageAvailableSchema = z
  .object({
    status: z.literal("available"),
    mimeType: TranscriptImageMimeTypeSchema,
    data: z
      .string()
      .min(1)
      .max(Math.ceil(TRANSCRIPT_IMAGE_MAX_BYTES / 3) * 4)
      .refine(isTranscriptImageBase64Alphabet)
      .refine((data) => data.length % 4 === 0)
      .refine((data) => getTranscriptImageBase64ByteLength(data) <= TRANSCRIPT_IMAGE_MAX_BYTES),
  })
  .strict();
const TranscriptImageUnavailableSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: TranscriptImageUnavailableReasonSchema,
  })
  .strict();
export const TranscriptImageSchema = z.discriminatedUnion("status", [
  TranscriptImageAvailableSchema,
  TranscriptImageUnavailableSchema,
]);

export type TranscriptImageMimeType = z.infer<typeof TranscriptImageMimeTypeSchema>;
export type TranscriptImage = z.infer<typeof TranscriptImageSchema>;

export function getTranscriptImageByteLength(image: TranscriptImage): number {
  return image.status === "available" ? getTranscriptImageBase64ByteLength(image.data) : 0;
}

export function validateTranscriptImageBytes(
  bytes: Uint8Array,
  mimeType: string,
): TranscriptImageUnavailableReason | null {
  if (bytes.byteLength > TRANSCRIPT_IMAGE_MAX_BYTES) return "oversized";
  if (!TranscriptImageMimeTypeSchema.safeParse(mimeType).success) return "unsupported_mime";
  const startsWith = (signature: readonly number[], offset = 0): boolean =>
    signature.every((value, index) => bytes[offset + index] === value);
  const ftypBoxSize =
    bytes.length >= 4 ? bytes[0]! * 0x1000000 + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]! : 0;
  const hasValidFtypBox = ftypBoxSize >= 16 && ftypBoxSize <= bytes.length;
  const isAvifFtyp = hasValidFtypBox && startsWith([0x66, 0x74, 0x79, 0x70], 4);
  const majorBrandIsAvif = startsWith([0x61, 0x76, 0x69, 0x66], 8) || startsWith([0x61, 0x76, 0x69, 0x73], 8);
  let hasAvifCompatibleBrand = false;
  for (let offset = 16; hasValidFtypBox && offset + 4 <= ftypBoxSize; offset += 4) {
    if (startsWith([0x61, 0x76, 0x69, 0x66], offset) || startsWith([0x61, 0x76, 0x69, 0x73], offset)) {
      hasAvifCompatibleBrand = true;
      break;
    }
  }
  const isAvif =
    isAvifFtyp && (majorBrandIsAvif || (startsWith([0x6d, 0x69, 0x66, 0x31], 8) && hasAvifCompatibleBrand));
  const matches =
    mimeType === "image/png"
      ? startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : mimeType === "image/jpeg"
        ? startsWith([0xff, 0xd8, 0xff])
        : mimeType === "image/gif"
          ? startsWith([0x47, 0x49, 0x46, 0x38]) &&
            (bytes[4] === 0x37 || bytes[4] === 0x39) &&
            bytes[5] === 0x61
          : mimeType === "image/webp"
            ? startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)
            : isAvif;
  return matches ? null : "mime_mismatch";
}

export function boundTranscriptImageBudget(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  let retainedBytes = 0;
  return messages.map((message) => {
    if (!message.images?.length) return { ...message };
    const images = message.images.map((image) => {
      if (image.status !== "available") return { ...image };
      const imageBytes = getTranscriptImageByteLength(image);
      if (retainedBytes + imageBytes > TRANSCRIPT_IMAGE_SESSION_MAX_BYTES) {
        return { status: "unavailable" as const, reason: "budget_exceeded" as const };
      }
      retainedBytes += imageBytes;
      return { ...image };
    });
    return { ...message, images };
  });
}

export const TRANSCRIPT_TEXT_LIMIT = 20_000;

export function truncateTranscriptText(text: string): string {
  if (text.length <= TRANSCRIPT_TEXT_LIMIT) return text;
  let end = TRANSCRIPT_TEXT_LIMIT;
  const finalCodeUnit = text.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

export const TranscriptToolLifecycleStateSchema = z.enum(["running", "success", "error"]);
export type TranscriptToolLifecycleState = z.infer<typeof TranscriptToolLifecycleStateSchema>;

export const TranscriptToolLifecycleRunningSchema = z
  .object({
    state: z.literal("running"),
  })
  .strict();
export const TranscriptToolLifecycleSuccessSchema = z
  .object({
    state: z.literal("success"),
  })
  .strict();
export const TranscriptToolLifecycleErrorSchema = z
  .object({
    state: z.literal("error"),
  })
  .strict();

export const TranscriptToolLifecycleSchema = z.discriminatedUnion("state", [
  TranscriptToolLifecycleRunningSchema,
  TranscriptToolLifecycleSuccessSchema,
  TranscriptToolLifecycleErrorSchema,
]);
export type TranscriptToolLifecycle = z.infer<typeof TranscriptToolLifecycleSchema>;

export const TranscriptMessageSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(["user", "assistant", "tool", "system"]),
    text: z.string(),
    timestamp: z.string(),
    streaming: z.boolean(),
    presentation: TranscriptPresentationSchema.default("text"),
    toolName: z.string().min(1).optional(),
    readTarget: z.string().min(1).optional(),
    readResolvedPath: z.string().min(1).optional(),
    toolTitle: z.string().min(1).optional(),
    images: z.array(TranscriptImageSchema).min(1).optional(),
    lifecycle: TranscriptToolLifecycleSchema.optional(),
  })
  .superRefine((message, context) => {
    if (!message.lifecycle) return;
    if (message.role !== "tool") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Tool lifecycle is only supported on tool messages",
        path: ["lifecycle"],
      });
    }
    if (message.lifecycle.state === "running" && !message.streaming) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Running lifecycle requires streaming message",
        path: ["lifecycle"],
      });
    }
    if (message.lifecycle.state !== "running" && message.streaming) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Terminal lifecycle state cannot be streaming",
        path: ["lifecycle"],
      });
    }
    if (message.lifecycle.state === "error" && message.presentation === "diff") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Error lifecycle cannot have diff presentation",
        path: ["lifecycle"],
      });
    }
  });

export const ActiveSubagentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lastActivity: z.string(),
});
export const SessionCostAgentSchema = z
  .object({
    sessionId: z.string().min(1),
    name: z.string().min(1),
    parentSessionId: z.string().min(1).nullable(),
    totalUsd: z.number().finite().nonnegative(),
    available: z.boolean(),
  })
  .strict();

export const SessionCostSummarySchema = z
  .object({
    totalUsd: z.number().finite().nonnegative(),
    partial: z.boolean(),
    agents: z.array(SessionCostAgentSchema),
  })
  .strict();

export const SkillCommandSchema = z.object({
  name: z.string().regex(/^skill:[^\s]+$/),
  description: z.string().trim().min(1).optional(),
});

export const AskDialogOptionSchema = z
  .object({
    label: z.string(),
    description: z.string().optional(),
    preview: z.string().optional(),
  })
  .strict();

export const AskDialogQuestionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    header: z.string().optional(),
    options: z.array(AskDialogOptionSchema),
    multi: z.boolean().optional(),
    recommended: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (question) => question.recommended === undefined || question.recommended < question.options.length,
    "Recommended option must refer to an available option",
  );

export const AskDialogResultItemSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    options: z.array(z.string()),
    multi: z.boolean(),
    selectedOptions: z.array(z.string()),
    customInput: z.string().optional(),
    note: z.string().optional(),
    timedOut: z.boolean().optional(),
  })
  .strict();

const LegacyAskRequestFields = {
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  title: z.string().min(1),
  options: z.array(z.string()).default([]),
  initialValue: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
};

export const AskRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...LegacyAskRequestFields, kind: z.literal("select") }).strict(),
  z.object({ ...LegacyAskRequestFields, kind: z.literal("text") }).strict(),
  z
    .object({
      sessionId: z.string().min(1),
      requestId: z.string().min(1),
      kind: z.literal("rich"),
      questions: z.array(AskDialogQuestionSchema).min(1),
      expiresAt: z.string().nullable().default(null),
    })
    .strict(),
]);

export const AskResponseSchema = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ kind: z.literal("submit"), results: z.array(AskDialogResultItemSchema) }).strict(),
  z.object({ kind: z.literal("chat") }).strict(),
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
  parentSessionId: z.string().min(1).nullable().optional(),
  costSummary: SessionCostSummarySchema.optional(),
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
export const SessionCostResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    costSummary: SessionCostSummarySchema.nullable(),
  })
  .strict();
export const SESSION_BRANCH_TOPOLOGY_MAX_BRANCHES = 10_000;
export const SESSION_BRANCH_NAME_MAX_BYTES = 4_096;
const utf8Encoder = new TextEncoder();
const SessionBranchNameSchema = z
  .string()
  .min(1)
  .max(SESSION_BRANCH_NAME_MAX_BYTES)
  .refine(
    (branch) => utf8Encoder.encode(branch).byteLength <= SESSION_BRANCH_NAME_MAX_BYTES,
    "Branch name exceeds the supported UTF-8 byte limit",
  );

export const SessionBranchTopologyNodeSchema = z
  .object({
    name: SessionBranchNameSchema,
    parent: SessionBranchNameSchema.optional(),
  })
  .strict();

export const SessionBranchTopologySchema = z
  .object({
    sessionId: z.string().min(1),
    branches: z.array(SessionBranchTopologyNodeSchema).max(SESSION_BRANCH_TOPOLOGY_MAX_BRANCHES),
    currentBranch: SessionBranchNameSchema,
  })
  .strict()
  .superRefine((topology, context) => {
    const names = new Set(topology.branches.map((branch) => branch.name));
    if (names.size !== topology.branches.length) {
      context.addIssue({ code: "custom", message: "Branch names must be unique", path: ["branches"] });
    }
    for (const [index, branch] of topology.branches.entries()) {
      if (branch.parent && !names.has(branch.parent)) {
        context.addIssue({
          code: "custom",
          message: "Branch parents must refer to a local branch",
          path: ["branches", index, "parent"],
        });
      }
    }
    const parentByName = new Map<string, string>();
    for (const branch of topology.branches) {
      if (branch.parent) parentByName.set(branch.name, branch.parent);
    }
    const checkedNames = new Set<string>();
    for (const [index, branch] of topology.branches.entries()) {
      if (checkedNames.has(branch.name)) continue;
      const path = new Set<string>();
      let name: string | undefined = branch.name;
      while (name && !checkedNames.has(name)) {
        if (path.has(name)) {
          context.addIssue({
            code: "custom",
            message: "Branch parents must not form a cycle",
            path: ["branches", index, "parent"],
          });
          break;
        }
        path.add(name);
        name = parentByName.get(name);
      }
      for (const visitedName of path) checkedNames.add(visitedName);
    }
    if (!names.has(topology.currentBranch)) {
      context.addIssue({ code: "custom", message: "Current branch must be listed", path: ["currentBranch"] });
    }
  });

export type SessionBranchTopologyNode = z.infer<typeof SessionBranchTopologyNodeSchema>;
export type SessionBranchTopology = z.infer<typeof SessionBranchTopologySchema>;

export const SwitchBranchCommandSchema = z
  .object({
    type: z.literal("switch_branch"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    branch: SessionBranchNameSchema.refine(
      (branch) => !branch.startsWith("-"),
      "Branch names cannot start with a dash",
    ),
  })
  .strict();

export type SwitchBranchCommand = z.infer<typeof SwitchBranchCommandSchema>;

export function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return text.endsWith("\n") ? count : count + 1;
}

export const SessionFileEditOperationSchema = z
  .object({
    type: z.literal("edit"),
    timestamp: z.string().datetime(),
    sessionId: z.string().min(1),
    op: z.enum(["create", "update", "delete", "rename"]).optional(),
    patch: z.string().min(1).optional(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (!operation.patch && (operation.additions !== 0 || operation.deletions !== 0)) {
      context.addIssue({
        code: "custom",
        message: "Edits without an exact patch cannot contribute line totals",
      });
    }
  });

export const SessionFileWriteOperationSchema = z
  .object({
    type: z.literal("write"),
    timestamp: z.string().datetime(),
    sessionId: z.string().min(1),
    resolvedPath: z.string().min(1),
    byteCount: z.number().int().nonnegative(),
    snapshot: z.string().optional(),
    additions: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      (operation.snapshot === undefined && operation.additions !== 0) ||
      (operation.snapshot !== undefined && countTextLines(operation.snapshot) !== operation.additions)
    ) {
      context.addIssue({
        code: "custom",
        message: "Write additions must match the retained snapshot",
      });
    }
    if (
      operation.snapshot !== undefined &&
      utf8Encoder.encode(operation.snapshot).byteLength !== operation.byteCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Write byteCount must match the retained snapshot",
      });
    }
  });

export const SessionFileOperationSchema = z.discriminatedUnion("type", [
  SessionFileEditOperationSchema,
  SessionFileWriteOperationSchema,
]);

export const SessionChangedFileSchema = z
  .object({
    path: z.string().min(1),
    operations: z.array(SessionFileOperationSchema).min(1),
  })
  .strict()
  .superRefine((file, context) => {
    for (let index = 1; index < file.operations.length; index += 1) {
      if (Date.parse(file.operations[index - 1]!.timestamp) > Date.parse(file.operations[index]!.timestamp)) {
        context.addIssue({ code: "custom", message: "File operations must be chronological" });
        break;
      }
    }
    for (const operation of file.operations) {
      if (operation.type === "write" && operation.resolvedPath !== file.path) {
        context.addIssue({ code: "custom", message: "Write resolved path must match its file" });
      }
    }
  });

export const SessionFileChangeSourceSchema = z
  .object({
    sessionId: z.string().min(1),
    root: z.string().min(1),
    files: z.array(SessionChangedFileSchema),
  })
  .strict()
  .superRefine((source, context) => {
    const paths = new Set(source.files.map((file) => file.path));
    if (paths.size !== source.files.length) {
      context.addIssue({ code: "custom", message: "Files must be unique within a source" });
    }
    for (const file of source.files) {
      if (file.operations.some((operation) => operation.sessionId !== source.sessionId)) {
        context.addIssue({ code: "custom", message: "Operation session must match its source" });
      }
    }
  });

export const SessionFileChangesResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    state: z.enum(["available", "partial", "unavailable"]),
    sources: z.array(SessionFileChangeSourceSchema),
    fileCount: z.number().int().nonnegative(),
    operationCount: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changedLines: z.number().int().nonnegative(),
    message: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    const sourceIdentities = new Set(
      response.sources.map((source) => `${source.sessionId}\u0000${source.root}`),
    );
    const files = response.sources.flatMap((source) => source.files);
    const operations = files.flatMap((file) => file.operations);
    const edits = operations.filter(
      (operation): operation is z.infer<typeof SessionFileEditOperationSchema> => operation.type === "edit",
    );
    const additions = operations.reduce((total, operation) => total + operation.additions, 0);
    const deletions = edits.reduce((total, operation) => total + operation.deletions, 0);
    if (sourceIdentities.size !== response.sources.length) {
      context.addIssue({ code: "custom", message: "Session/worktree sources must be unique" });
    }
    if (
      response.fileCount !== files.length ||
      response.operationCount !== operations.length ||
      response.additions !== additions ||
      response.deletions !== deletions ||
      response.changedLines !== additions + deletions
    ) {
      context.addIssue({ code: "custom", message: "Session file change totals do not match sources" });
    }
    if (response.state === "unavailable" && response.sources.length > 0) {
      context.addIssue({ code: "custom", message: "Unavailable responses cannot contain sources" });
    }
  });

const Base64UrlKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Expected unpadded base64url")
  .refine((value) => {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    try {
      atob(padded);
      return true;
    } catch {
      return false;
    }
  }, "Expected valid base64url");
function base64UrlKeyOfBytes(byteLength: number) {
  return Base64UrlKeySchema.refine((value) => {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    try {
      return atob(padded).length === byteLength;
    } catch {
      return false;
    }
  }, `Expected a ${byteLength}-byte base64url key`);
}
export const PushEventPreferencesSchema = z
  .object({ inputRequired: z.boolean(), sessionIdle: z.boolean() })
  .strict();
export const NotificationEventKeySchema = z.enum(["inputRequired", "sessionIdle"]);
export type NotificationEventKey = z.infer<typeof NotificationEventKeySchema>;
function containsAsciiControl(path: string): boolean {
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
export const NotificationSessionPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    (path) =>
      path.startsWith("/") &&
      !path.startsWith("//") &&
      !path.includes("\\") &&
      !containsAsciiControl(path) &&
      (() => {
        try {
          return new URL(path, "https://omp.invalid").origin === "https://omp.invalid";
        } catch {
          return false;
        }
      })(),
    "Notification URL must be a same-origin session path",
  );
export const NotificationEventSchema = z
  .object({
    type: z.literal("notification_event"),
    event: NotificationEventKeySchema,
    title: z.enum(["Input required", "Session idle"]),
    body: z.string().trim().min(1).max(1_000),
    tag: z.string().trim().min(1).max(256),
    url: NotificationSessionPathSchema,
  })
  .strict()
  .superRefine((notification, context) => {
    const expectedTitle = notification.event === "inputRequired" ? "Input required" : "Session idle";
    if (notification.title !== expectedTitle) {
      context.addIssue({
        code: "custom",
        message: "Notification title must match its event",
        path: ["title"],
      });
    }
  });
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;
export const PushSubscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine((endpoint) => {
        try {
          return new URL(endpoint).protocol === "https:";
        } catch {
          return false;
        }
      }, "Push subscription endpoint must use HTTPS"),
    keys: z.object({ p256dh: base64UrlKeyOfBytes(65), auth: base64UrlKeyOfBytes(16) }).strict(),
  })
  .strict();
export const PushVapidPublicKeySchema = base64UrlKeyOfBytes(65);
const PushDeviceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (deviceId) => new TextEncoder().encode(deviceId).byteLength <= 128,
    "Device id exceeds the supported UTF-8 byte limit",
  );
export const PushSubscriptionRegistrationSchema = z
  .object({
    deviceId: PushDeviceIdSchema,
    subscription: PushSubscriptionSchema,
    events: PushEventPreferencesSchema,
  })
  .strict();
export const PushSubscriptionUpdateSchema = PushSubscriptionRegistrationSchema;
export const PushSubscriptionRemovalSchema = z.object({ deviceId: PushDeviceIdSchema }).strict();
export const PushVapidPublicKeyResponseSchema = z.object({ publicKey: PushVapidPublicKeySchema }).strict();
export type PushEventPreferences = z.infer<typeof PushEventPreferencesSchema>;
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;
export type PushSubscriptionRegistration = z.infer<typeof PushSubscriptionRegistrationSchema>;
export type PushSubscriptionUpdate = z.infer<typeof PushSubscriptionUpdateSchema>;
export type PushSubscriptionRemoval = z.infer<typeof PushSubscriptionRemovalSchema>;

const CommandTextSchema = z.string().trim().min(1).max(100_000);

export const BrowserCommandSchema = z.union([
  z.object({
    type: z.literal("launch"),
    requestId: z.string().min(1),
    cwd: z.string().trim().min(1),
    resume: z.string().trim().min(1).nullable(),
  }),
  z.object({
    type: z.literal("save_working_directory"),
    requestId: z.string().min(1),
    cwd: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("remove_working_directory"),
    requestId: z.string().min(1),
    cwd: z.string().trim().min(1),
  }),
  SwitchBranchCommandSchema,
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
  z
    .object({
      type: z.literal("ask_activity"),
      sessionId: z.string().min(1),
      askRequestId: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal("push_vapid_public_key"), requestId: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("push_subscription_register"),
      requestId: z.string().min(1),
      deviceId: PushDeviceIdSchema,
      subscription: PushSubscriptionSchema,
      events: PushEventPreferencesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("push_subscription_update"),
      requestId: z.string().min(1),
      deviceId: PushDeviceIdSchema,
      subscription: PushSubscriptionSchema,
      events: PushEventPreferencesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("push_subscription_remove"),
      requestId: z.string().min(1),
      deviceId: PushDeviceIdSchema,
    })
    .strict(),
]);

export const CommandResultSchema = z.object({
  type: z.literal("command_result"),
  requestId: z.string(),
  outcome: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      value: z.discriminatedUnion("type", [
        z.object({ type: z.literal("launch"), sessionId: z.string().min(1) }),
        z.object({ type: z.literal("push_vapid_public_key"), publicKey: PushVapidPublicKeySchema }),
        z.object({ type: z.literal("void") }),
      ]),
    }),
    z.object({
      status: z.literal("error"),
      error: z.string().nullable(),
    }),
  ]),
});

export const ServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    sessions: z.array(SessionSchema),
    askRequests: z.array(AskRequestSchema).default([]),
    savedWorkingDirectories: z.array(z.string().trim().min(1)).default([]),
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
    type: z.literal("saved_working_directories"),
    savedWorkingDirectories: z.array(z.string().trim().min(1)),
  }),
  NotificationEventSchema,
  CommandResultSchema,
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
  z.object({ type: z.literal("ask_request"), request: AskRequestSchema }),
  z
    .object({
      type: z.literal("ask_activity"),
      sessionId: z.string().min(1),
      requestId: z.string().min(1),
    })
    .strict(),
  z.object({
    type: z.literal("ask_cancelled"),
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
  }),
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
  z.object({ requestId: z.string().min(1), command: z.literal("ask_admitted") }),
  z.object({
    requestId: z.string().min(1),
    command: z.literal("ask_response"),
    response: AskResponseSchema,
  }),
  z.object({ requestId: z.string().min(1), command: z.literal("ask_unavailable") }),
]);

export type AskRequest = z.infer<typeof AskRequestSchema>;
export type AskResponse = z.infer<typeof AskResponseSchema>;
export type AskDialogOption = z.infer<typeof AskDialogOptionSchema>;
export type AskDialogQuestion = z.infer<typeof AskDialogQuestionSchema>;
export type AskDialogResultItem = z.infer<typeof AskDialogResultItemSchema>;
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type Effort = z.infer<typeof EffortSchema>;
export type RoleEffort = z.infer<typeof RoleEffortSchema>;
export type ActiveSubagent = z.infer<typeof ActiveSubagentSchema>;
export type ExtensionCommand = z.infer<typeof ExtensionCommandSchema>;
export type ExtensionFrame = z.infer<typeof ExtensionFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type SessionCatalogPage = z.infer<typeof SessionCatalogPageSchema>;
export type SessionCostResponse = z.infer<typeof SessionCostResponseSchema>;
export type SessionTranscriptResponse = z.infer<typeof SessionTranscriptResponseSchema>;
export type SessionChangedFile = z.infer<typeof SessionChangedFileSchema>;
export type SessionFileChangeSource = z.infer<typeof SessionFileChangeSourceSchema>;
export type SessionFileChangesResponse = z.infer<typeof SessionFileChangesResponseSchema>;
export type SessionFileOperation = z.infer<typeof SessionFileOperationSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type SessionModelOption = z.infer<typeof SessionModelOptionSchema>;
export type SessionPatch = z.infer<typeof SessionPatchSchema>;
export type SessionCapability = z.infer<typeof SessionCapabilitySchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SkillCommand = z.infer<typeof SkillCommandSchema>;
export type SessionCostAgent = z.infer<typeof SessionCostAgentSchema>;
export type SessionCostSummary = z.infer<typeof SessionCostSummarySchema>;
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;

export function compareSessionsByCreation(left: Session, right: Session): number {
  return right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}

export function getMainSessionIds(sessions: readonly Session[]): Set<string> {
  const mainSessionIds = new Set<string>();
  const subagentIds = new Set<string>();
  const sessionPaths = new Set<string>();
  const explicitTopologyById = new Map<string, string | null>();

  for (const session of sessions) {
    if (session.parentSessionId !== undefined) explicitTopologyById.set(session.id, session.parentSessionId);
    if (session.sessionPath?.endsWith(".jsonl")) sessionPaths.add(session.sessionPath);
    for (const subagent of session.activeSubagents) subagentIds.add(subagent.id);
  }
  for (const session of sessions) {
    const explicitParentSessionId = explicitTopologyById.get(session.id);
    if (explicitTopologyById.has(session.id)) {
      if (explicitParentSessionId === null) mainSessionIds.add(session.id);
      continue;
    }
    mainSessionIds.add(session.id);
    if (subagentIds.has(session.id) || hasSessionPathAncestor(session.sessionPath, sessionPaths)) {
      mainSessionIds.delete(session.id);
    }
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
