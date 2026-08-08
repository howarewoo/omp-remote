import { createHash } from "node:crypto";
import { closeSync, existsSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionAskDialogQuestion,
  ExtensionAskDialogResult,
  ExtensionContext,
  ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent";
import {
  type AskResponse,
  boundTranscriptImageBudget,
  type ExtensionCommand,
  getTranscriptImageByteLength,
  TRANSCRIPT_IMAGE_MAX_BYTES,
  TRANSCRIPT_IMAGE_SESSION_MAX_BYTES,
  type TranscriptImage,
  type TranscriptImageMimeType,
  type TranscriptMessage,
  validateTranscriptImageBytes,
} from "@omp-remote/protocol";

const DEFAULT_EXTENSION_URL = "ws://127.0.0.1:4387/extension";
const RECONNECT_DELAY_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const MODEL_ROLE_ORDER = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "designer",
  "commit",
  "tiny",
  "task",
  "advisor",
];

type ModelRoleResolver = (role: string) => { provider: string; id: string } | undefined;

function getConfiguredRoles(resolveRole?: ModelRoleResolver): Map<string, string[]> {
  const rolesByModel = new Map<string, string[]>();
  if (!resolveRole) return rolesByModel;

  for (const role of MODEL_ROLE_ORDER) {
    const model = resolveRole(role);
    if (!model) continue;
    const key = `${model.provider}/${model.id}`;
    const roles = rolesByModel.get(key);
    if (roles) roles.push(role);
    else rolesByModel.set(key, [role]);
  }
  return rolesByModel;
}

function sortConfiguredRoleModels(
  models: readonly ModelSummary[],
  rolesByModel: ReadonlyMap<string, readonly string[]>,
): ModelSummary[] {
  return models
    .map((model, index) => ({
      model,
      index,
      rank: rolesByModel.has(`${model.provider}/${model.id}`)
        ? MODEL_ROLE_ORDER.indexOf(rolesByModel.get(`${model.provider}/${model.id}`)?.[0] ?? "")
        : MODEL_ROLE_ORDER.length,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ model }) => model);
}

type ExtensionTranscriptMessage = TranscriptMessage;

export function boundExtensionTranscriptMessages(
  messages: readonly ExtensionTranscriptMessage[],
): ExtensionTranscriptMessage[] {
  return boundTranscriptImageBudget(messages);
}

type TranscriptRole = TranscriptMessage["role"];

type FallbackId = string | (() => string);
type AvailableCommand = {
  name: string;
  description?: string;
  source: string;
};

type ExtensionSkillCommand = {
  name: string;
  description?: string;
};

type EffortName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ExtensionThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
type RemoteAskOutcome =
  | { type: "response"; response: ExtensionAskDialogResult | undefined }
  | { type: "timeout" }
  | { type: "unavailable" };
type ModelSummary = {
  provider: string;
  id: string;
  name: string;
  thinking?: { efforts: readonly Exclude<EffortName, "off">[]; requiresEffort?: boolean };
};
export function getSessionModelOptions(models: readonly ModelSummary[], resolveRole?: ModelRoleResolver) {
  const rolesByModel = getConfiguredRoles(resolveRole);
  return sortConfiguredRoleModels(models, rolesByModel).map((model) => {
    const roles = rolesByModel.get(`${model.provider}/${model.id}`);
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      efforts: model.thinking
        ? [...(model.thinking.requiresEffort ? [] : (["off"] as const)), ...model.thinking.efforts]
        : [],
      ...(roles?.length ? { roles } : {}),
    };
  });
}

export function getSkillCommands(commands: readonly AvailableCommand[]): ExtensionSkillCommand[] {
  return commands
    .filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
    .map((command) => ({
      name: command.name,
      ...(command.description?.trim() ? { description: command.description.trim() } : {}),
    }));
}

type TrackedToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

type RawExtensionMessage = {
  id?: unknown;
  role: string;
  content: string | Array<{ type: string; text?: string; data?: unknown; mimeType?: unknown }>;
  timestamp?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  details?: unknown;
  isError?: unknown;
};

type ExtensionToolDetails = {
  diff?: unknown;
  path?: unknown;
  resolvedPath?: unknown;
  meta?: { source?: { value?: unknown } };
  perFileResults?: unknown[];
  matchCount?: unknown;
  fileCount?: unknown;
  scopePath?: unknown;
  to?: unknown;
  receipts?: unknown;
  waited?: unknown;
};

export class ExtensionToolCallTracker {
  readonly #calls = new Map<string, TrackedToolCall>();

  capture(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (
        typeof part !== "object" ||
        part === null ||
        part.type !== "toolCall" ||
        typeof part.arguments !== "object" ||
        part.arguments === null ||
        Array.isArray(part.arguments)
      ) {
        continue;
      }
      const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : part.id;
      const toolName = typeof part.toolName === "string" ? part.toolName : part.name;
      if (typeof toolCallId === "string" && toolCallId && typeof toolName === "string" && toolName) {
        this.#calls.set(toolCallId, {
          toolName,
          arguments: part.arguments as Record<string, unknown>,
        });
      }
    }
  }

  resolve(toolCallId: unknown, consume = false): TrackedToolCall | undefined {
    if (typeof toolCallId !== "string") return undefined;
    const toolCall = this.#calls.get(toolCallId);
    if (consume) this.#calls.delete(toolCallId);
    return toolCall;
  }
}

export function normalizeExtensionMessage(
  raw: unknown,
  streaming: boolean,
  fallbackId: FallbackId,
  toolCallTracker?: ExtensionToolCallTracker,
  resolveReadImage?: (data: string, mimeType: string) => TranscriptImage,
): ExtensionTranscriptMessage | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("role" in raw) ||
    typeof raw.role !== "string" ||
    !("content" in raw) ||
    !isContent(raw.content)
  ) {
    return null;
  }
  const message = raw as RawExtensionMessage;
  if (message.id !== undefined && typeof message.id !== "string") return null;

  if (message.role === "assistant") toolCallTracker?.capture(message.content);
  const toolName =
    typeof message.toolName === "string" && message.toolName.trim() ? message.toolName : undefined;
  const resolvedToolCall =
    message.role === "toolResult" ? toolCallTracker?.resolve(message.toolCallId, !streaming) : undefined;
  const toolCall = resolvedToolCall?.toolName === toolName ? resolvedToolCall : undefined;
  const details =
    typeof message.details === "object" && message.details !== null && !Array.isArray(message.details)
      ? (message.details as ExtensionToolDetails)
      : undefined;
  const appliedDiff =
    message.role === "toolResult" && toolName === "edit" && typeof details?.diff === "string"
      ? details.diff
      : undefined;
  const canonicalDiff = message.isError === false ? appliedDiff : undefined;
  const text = canonicalDiff ?? extractText(message.content);
  if (!text && message.role !== "toolResult") return null;
  if (
    message.timestamp !== undefined &&
    typeof message.timestamp !== "string" &&
    typeof message.timestamp !== "number"
  ) {
    return null;
  }

  const trackedReadTarget = normalizeBoundedSingleLine(toolCall?.arguments.path);
  const readSourcePath = normalizeBoundedSingleLine(details?.meta?.source?.value);
  const readTarget =
    toolName === "read"
      ? (trackedReadTarget ?? readSourcePath ?? normalizeBoundedSingleLine(details?.path))
      : undefined;
  const readResolvedPath =
    toolName === "read"
      ? (normalizeBoundedSingleLine(details?.resolvedPath) ??
        (trackedReadTarget?.startsWith("skill://") ? readSourcePath : undefined))
      : undefined;
  const images =
    message.role === "toolResult" && toolName === "read"
      ? extractReadImages(message.content, resolveReadImage, message.isError === true)
      : undefined;
  const toolTitle =
    message.role === "toolResult"
      ? formatExtensionToolTitle(toolName, toolCall?.arguments, details, appliedDiff)
      : undefined;

  return {
    id:
      typeof message.id === "string"
        ? message.id
        : typeof fallbackId === "function"
          ? fallbackId()
          : fallbackId,
    role: normalizeRole(message.role),
    text,
    timestamp:
      typeof message.timestamp === "number"
        ? new Date(message.timestamp).toISOString()
        : typeof message.timestamp === "string"
          ? message.timestamp
          : new Date().toISOString(),
    streaming,
    presentation: canonicalDiff !== undefined ? "diff" : "text",
    ...(toolName ? { toolName } : {}),
    ...(readTarget ? { readTarget } : {}),
    ...(readResolvedPath ? { readResolvedPath } : {}),
    ...(images?.length ? { images } : {}),
    ...(toolTitle ? { toolTitle } : {}),
  };
}
function extractReadImages(
  content: RawExtensionMessage["content"],
  resolveReadImage?: (data: string, mimeType: string) => TranscriptImage,
  readError = false,
): TranscriptImage[] {
  if (!Array.isArray(content)) return [];
  const images: TranscriptImage[] = [];
  for (const part of content) {
    if (part.type !== "image") continue;
    if (readError) {
      images.push({ status: "unavailable", reason: "invalid_reference" });
      continue;
    }
    if (typeof part.data !== "string") {
      images.push({ status: "unavailable", reason: "invalid_reference" });
      continue;
    }
    if (typeof part.mimeType !== "string") {
      images.push({ status: "unavailable", reason: "unsupported_mime" });
      continue;
    }
    images.push(resolveReadImage?.(part.data, part.mimeType) ?? { status: "unavailable", reason: "missing" });
  }
  return images;
}
export function materializeExtensionReadImages(
  message: ExtensionTranscriptMessage,
  raw: unknown,
  resolveReadImage: (data: string, mimeType: string) => TranscriptImage,
): ExtensionTranscriptMessage {
  if (message.toolName !== "read") return message;
  if (typeof raw !== "object" || raw === null || !("content" in raw) || !isContent(raw.content)) {
    return message;
  }
  const images = extractReadImages(raw.content, resolveReadImage, "isError" in raw && raw.isError === true);
  return images.length ? { ...message, images } : message;
}

function formatExtensionToolTitle(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
  details: ExtensionToolDetails | undefined,
  canonicalDiff: string | undefined,
): string | undefined {
  if (toolName === "bash") {
    const command = normalizeHeaderValue(args?.command);
    return command ? `Bash: ${command}` : undefined;
  }
  if (toolName === "write") {
    const path = normalizeBoundedSingleLine(args?.path);
    return path ? `Write: ${path}` : undefined;
  }
  if (toolName === "edit") {
    const inputPaths = extractEditPaths(args?.input);
    const perFilePaths = Array.isArray(details?.perFileResults)
      ? details.perFileResults
          .map((result) =>
            typeof result === "object" && result !== null && "path" in result
              ? normalizeBoundedSingleLine(result.path)
              : undefined,
          )
          .filter((path): path is string => Boolean(path))
      : [];
    const detailPath = normalizeBoundedSingleLine(details?.path);
    const paths = inputPaths.length > 0 ? inputPaths : [...perFilePaths, ...(detailPath ? [detailPath] : [])];
    const pathLabel =
      paths.length === 0 ? null : `${paths[0]}${paths.length > 1 ? ` +${paths.length - 1} more` : ""}`;
    const changes = canonicalDiff ? countDiffChanges(canonicalDiff) : null;
    const changeLabel = changes
      ? [
          changes.added > 0 ? `⟦+${changes.added}⟧` : null,
          changes.removed > 0 ? `⟦−${changes.removed}⟧` : null,
        ]
          .filter(Boolean)
          .join(" ")
      : "";
    return pathLabel ? `Edit: 🟦 ${pathLabel}${changeLabel ? ` ${changeLabel}` : ""}` : undefined;
  }
  if (toolName === "grep") {
    const pattern = normalizeHeaderValue(args?.pattern);
    if (!pattern) return undefined;
    const matchCount =
      typeof details?.matchCount === "number" &&
      Number.isInteger(details.matchCount) &&
      details.matchCount >= 0
        ? details.matchCount
        : undefined;
    const fileCount =
      typeof details?.fileCount === "number" && Number.isInteger(details.fileCount) && details.fileCount >= 0
        ? details.fileCount
        : undefined;
    const rawScope = normalizeBoundedSingleLine(args?.path) ?? normalizeBoundedSingleLine(details?.scopePath);
    const scope = rawScope
      ?.split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(", ");
    const countLabel =
      matchCount === undefined || fileCount === undefined
        ? ""
        : ` ${matchCount} ${matchCount === 1 ? "match" : "matches"} · ${fileCount} ${
            fileCount === 1 ? "file" : "files"
          }`;
    return `Grep: ${pattern}${countLabel}${scope ? ` · in ${scope}` : ""}`;
  }
  if (toolName === "hub") {
    const waited = details?.waited;
    const incomingFrom =
      typeof waited === "object" && waited !== null && "from" in waited
        ? normalizeHeaderValue(waited.from)
        : undefined;
    if (incomingFrom) return `✉ IRC ⟵ ${incomingFrom}`;

    if (args?.op !== "send") return undefined;
    const target = normalizeHeaderValue(args.to) ?? normalizeHeaderValue(details?.to);
    if (!target) return undefined;
    const receipt = Array.isArray(details?.receipts)
      ? details.receipts.find(
          (candidate) =>
            typeof candidate === "object" &&
            candidate !== null &&
            "to" in candidate &&
            candidate.to === target,
        )
      : undefined;
    const outcome =
      typeof receipt === "object" && receipt !== null && "outcome" in receipt
        ? normalizeIrcOutcome(receipt.outcome)
        : undefined;
    return `IRC ➤ ${target}${outcome ? ` ${outcome}` : ""}`;
  }
  return undefined;
}

function extractEditPaths(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const paths: string[] = [];
  const patterns = [/^\[([^#\r\n]+)#[\dA-Fa-f]{4}\]$/gm, /^\*\*\* (?:Add|Delete|Update) File:\s*(.+)$/gm];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const path = normalizeBoundedSingleLine(match[1]);
      if (path && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

function countDiffChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r\n|\n|\r/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function normalizeBoundedSingleLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 10_000 && !/[\0\r\n]/.test(normalized) ? normalized : undefined;
}

function normalizeHeaderValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= 10_000 ? normalized : undefined;
}

function normalizeIrcOutcome(value: unknown): string | undefined {
  return value === "injected" || value === "woken" || value === "revived" || value === "failed"
    ? value
    : undefined;
}

function isContent(value: unknown): value is string | Array<{ type: string; text?: string }> {
  return (
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.every(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          typeof part.type === "string" &&
          (!("text" in part) || part.text === undefined || typeof part.text === "string"),
      ))
  );
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  let text = "";
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text;
}

function normalizeRole(role: string): TranscriptRole {
  if (role === "toolResult") return "tool";
  return role === "user" || role === "assistant" || role === "tool" ? role : "system";
}

export function isRpcMode(argv: readonly string[] = process.argv): boolean {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    if (argument === "--mode") return argv[index + 1] === "rpc" || argv[index + 1] === "rpc-ui";
    if (argument?.startsWith("--mode=")) {
      const mode = argument.slice("--mode=".length);
      return mode === "rpc" || mode === "rpc-ui";
    }
  }

  return false;
}
export function normalizeRemoteAskResponse(value: unknown): RemoteAskOutcome | null {
  if (typeof value !== "object" || value === null) return null;
  if ("timedOut" in value && value.timedOut === true && "cancelled" in value && value.cancelled === true) {
    return { type: "timeout" };
  }
  if ("cancelled" in value && value.cancelled === true) {
    return { type: "response", response: undefined };
  }
  if ("kind" in value && value.kind === "chat") {
    return { type: "response", response: { kind: "chat" } };
  }
  if (
    !("kind" in value) ||
    value.kind !== "submit" ||
    !("results" in value) ||
    !Array.isArray(value.results)
  ) {
    return null;
  }
  for (const result of value.results) {
    if (
      typeof result !== "object" ||
      result === null ||
      !("id" in result) ||
      typeof result.id !== "string" ||
      !("question" in result) ||
      typeof result.question !== "string" ||
      !("options" in result) ||
      !isStringArray(result.options) ||
      !("multi" in result) ||
      typeof result.multi !== "boolean" ||
      !("selectedOptions" in result) ||
      !isStringArray(result.selectedOptions) ||
      ("customInput" in result &&
        result.customInput !== undefined &&
        typeof result.customInput !== "string") ||
      ("note" in result && result.note !== undefined && typeof result.note !== "string") ||
      ("timedOut" in result && result.timedOut !== undefined && typeof result.timedOut !== "boolean")
    ) {
      return null;
    }
  }
  return { type: "response", response: value as ExtensionAskDialogResult };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function resolveOwnReadImage(
  reference: string,
  mimeType: string,
  maxBytes = TRANSCRIPT_IMAGE_MAX_BYTES,
): TranscriptImage {
  const match = /^blob:sha256:([a-f0-9]{64})$/.exec(reference);
  const hash = match?.[1];
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
  if (!hash) return { status: "unavailable", reason: "invalid_reference" };
  let handle: number | undefined;
  try {
    const blobPath = join(agentDirectory, "blobs", hash);
    handle = openSync(blobPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fileStats = fstatSync(handle);
    if (!fileStats.isFile()) return { status: "unavailable", reason: "invalid_reference" };
    if (fileStats.size > TRANSCRIPT_IMAGE_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    if (fileStats.size > maxBytes) return { status: "unavailable", reason: "budget_exceeded" };
    const buffer = Buffer.allocUnsafe(Math.min(TRANSCRIPT_IMAGE_MAX_BYTES, maxBytes) + 1);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    if (bytesRead > TRANSCRIPT_IMAGE_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    if (bytesRead > maxBytes) return { status: "unavailable", reason: "budget_exceeded" };
    const bytes = buffer.subarray(0, bytesRead);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
      return { status: "unavailable", reason: "invalid_reference" };
    }
    const reason = validateTranscriptImageBytes(bytes, mimeType);
    if (reason) return { status: "unavailable", reason };
    return {
      status: "available",
      mimeType: mimeType as TranscriptImageMimeType,
      data: bytes.toString("base64"),
    };
  } catch {
    return { status: "unavailable", reason: "missing" };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function createOwnReadImageResolver(maxBytes: number) {
  let remainingBytes = maxBytes;
  return (reference: string, mimeType: string): TranscriptImage => {
    if (remainingBytes <= 0) return { status: "unavailable", reason: "budget_exceeded" };
    const image = resolveOwnReadImage(reference, mimeType, remainingBytes);
    if (image.status === "available") remainingBytes -= getTranscriptImageByteLength(image);
    return image;
  };
}

export default function ompRemoteExtension(pi: ExtensionAPI): void {
  const rpcMode = isRpcMode();
  const { z } = pi.zod;
  const AskDialogResultItemSchema = z
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
  const AskResponseSchema = z.union([
    z.object({ value: z.string() }).strict(),
    z.object({ kind: z.literal("submit"), results: z.array(AskDialogResultItemSchema) }).strict(),
    z.object({ kind: z.literal("chat") }).strict(),
    z.object({ cancelled: z.literal(true), timedOut: z.boolean().optional() }).strict(),
  ]);
  const CommandSchema = z.union([
    z.object({
      requestId: z.string(),
      command: z.enum(["prompt", "steer", "follow_up"]),
      text: z.string().min(1),
    }),
    z.object({ requestId: z.string(), command: z.literal("abort") }),
    z.object({
      requestId: z.string(),
      command: z.literal("set_model"),
      model: z.string().regex(/^[^/]+\/.+$/),
    }),
    z.object({
      requestId: z.string(),
      command: z.literal("set_effort"),
      effort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    }),
    z.object({ requestId: z.string().min(1), command: z.literal("ask_admitted") }),
    z.object({
      requestId: z.string().min(1),
      command: z.literal("ask_response"),
      response: AskResponseSchema,
    }),
    z.object({ requestId: z.string().min(1), command: z.literal("ask_unavailable") }),
  ]);
  const SessionEntrySchema = z
    .object({ id: z.string(), type: z.literal("message"), message: z.unknown() })
    .passthrough();
  const sessionCreatedAt = new Map<string, string>();
  type AskRelay = {
    context: ExtensionContext;
    nativeAskDialog: NonNullable<ExtensionContext["ui"]["askDialog"]>;
  };
  type PendingRemoteAsk = {
    sessionId: string;
    relay: AskRelay;
    admitted: boolean;
    settled: boolean;
    admit(): void;
    settle(outcome: RemoteAskOutcome): void;
    unsubscribeTerminalInput?: () => void;
  };
  const pendingRemoteAsks = new Map<string, PendingRemoteAsk>();
  let askRelay: AskRelay | undefined;

  let context: ExtensionContext | undefined;
  let socket: WebSocket | undefined;
  let active = false;
  let activeMessageId: string | undefined;
  let messageSequence = 0;
  const liveToolCallTracker = new ExtensionToolCallTracker();
  let producerReadImageResolver: (data: string, mimeType: string) => TranscriptImage = resolveOwnReadImage;
  const retainedMessagesBySession = new Map<string, Map<string, ExtensionTranscriptMessage>>();

  const boundLiveMessage = (
    sessionId: string,
    message: ExtensionTranscriptMessage,
  ): ExtensionTranscriptMessage => {
    const retained =
      retainedMessagesBySession.get(sessionId) ?? new Map<string, ExtensionTranscriptMessage>();
    retained.set(message.id, message);
    while (retained.size > 200) {
      const oldestId = retained.keys().next().value;
      if (oldestId === undefined) break;
      retained.delete(oldestId);
    }
    const bounded = boundExtensionTranscriptMessages([...retained.values()]);
    retained.clear();
    for (const retainedMessage of bounded) retained.set(retainedMessage.id, retainedMessage);
    retainedMessagesBySession.set(sessionId, retained);
    return retained.get(message.id) ?? message;
  };

  const normalizeContextPercent = (ctx: ExtensionContext): number | null => {
    const percent = ctx.getContextUsage()?.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
    return Math.max(0, Math.min(100, percent <= 1 ? percent * 100 : percent));
  };

  const normalizeMessage = (
    raw: unknown,
    streaming: boolean,
    fallbackId?: string,
    toolCallTracker = liveToolCallTracker,
  ) =>
    normalizeExtensionMessage(
      raw,
      streaming,
      fallbackId ?? (() => `extension-message-${++messageSequence}`),
      toolCallTracker,
      producerReadImageResolver,
    );

  const send = (frame: object): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const cleanupRemoteAsk = (requestId: string): PendingRemoteAsk | undefined => {
    const pending = pendingRemoteAsks.get(requestId);
    if (!pending) return undefined;
    pendingRemoteAsks.delete(requestId);
    pending.unsubscribeTerminalInput?.();
    delete pending.unsubscribeTerminalInput;
    return pending;
  };

  const cancelRemoteAsk = (requestId: string): void => {
    const pending = cleanupRemoteAsk(requestId);
    if (!pending) return;
    send({ type: "ask_cancelled", sessionId: pending.sessionId, requestId });
  };

  const loseRemoteAsks = (): void => {
    for (const [requestId, pending] of pendingRemoteAsks) {
      pending.settle({ type: "unavailable" });
      cleanupRemoteAsk(requestId);
    }
  };

  const installAskRelay = (ctx: ExtensionContext): void => {
    if (askRelay) {
      askRelay.context = ctx;
      return;
    }
    if (!ctx.ui) return;
    const existing = Reflect.getOwnPropertyDescriptor(ctx.ui, "askDialog")?.value as
      | NonNullable<ExtensionContext["ui"]["askDialog"]>
      | undefined;
    if (!existing) return;
    const relay: AskRelay = {
      context: ctx,
      nativeAskDialog: existing,
    };
    askRelay = relay;
    ctx.ui.askDialog = async (
      questions: ExtensionAskDialogQuestion[],
      dialogOptions?: ExtensionUIDialogOptions,
    ): Promise<ExtensionAskDialogResult | undefined> => {
      const localAskDialog = (
        localQuestions: ExtensionAskDialogQuestion[],
        localOptions?: ExtensionUIDialogOptions,
      ) => relay.nativeAskDialog.call(relay.context.ui, localQuestions, localOptions);
      if (socket?.readyState !== WebSocket.OPEN) return localAskDialog(questions, dialogOptions);

      const requestId = crypto.randomUUID();
      const sessionId = relay.context.sessionManager.getSessionId();
      let resolveAdmission!: () => void;
      let resolveRemote!: (outcome: RemoteAskOutcome) => void;
      let resolveAbort!: () => void;
      const admission = new Promise<void>((resolve) => {
        resolveAdmission = resolve;
      });
      const remote = new Promise<RemoteAskOutcome>((resolve) => {
        resolveRemote = resolve;
      });
      const parentAbort = new Promise<"aborted">((resolve) => {
        resolveAbort = () => resolve("aborted");
      });
      const pending: PendingRemoteAsk = {
        sessionId,
        relay,
        admitted: false,
        settled: false,
        admit() {
          if (this.admitted || this.settled) return;
          this.admitted = true;
          this.unsubscribeTerminalInput = this.relay.context.ui.onTerminalInput(() => {
            if (pendingRemoteAsks.get(requestId) === this && this.admitted && !this.settled) {
              send({ type: "ask_activity", sessionId: this.sessionId, requestId });
            }
            return undefined;
          });
          resolveAdmission();
        },
        settle(outcome) {
          if (this.settled) return;
          this.settled = true;
          resolveRemote(outcome);
        },
      };
      pendingRemoteAsks.set(requestId, pending);
      const onParentAbort = () => resolveAbort();
      dialogOptions?.signal?.addEventListener("abort", onParentAbort, { once: true });
      if (dialogOptions?.signal?.aborted) resolveAbort();
      const timeout = dialogOptions?.timeout;
      const expiresAt =
        typeof timeout === "number" && timeout > 0 ? new Date(Date.now() + timeout).toISOString() : null;
      send({
        type: "ask_request",
        request: { sessionId, requestId, kind: "rich", questions, expiresAt },
      });

      const remoteResult = async (
        outcome: RemoteAskOutcome,
      ): Promise<ExtensionAskDialogResult | undefined> => {
        cleanupRemoteAsk(requestId);
        if (outcome.type === "unavailable") return localAskDialog(questions, dialogOptions);
        if (outcome.type === "response") return outcome.response;
        dialogOptions?.onTimeout?.();
        return {
          kind: "submit",
          results: questions.map((question) => {
            const selected = question.options[question.recommended ?? 0];
            return {
              id: question.id,
              question: question.question,
              options: question.options.map((option) => option.label),
              multi: question.multi ?? false,
              selectedOptions: selected ? [selected.label] : [],
              timedOut: true,
            };
          }),
        };
      };

      const first = await Promise.race([
        admission.then(() => ({ source: "admitted" as const })),
        remote.then((outcome) => ({ source: "remote" as const, outcome })),
        parentAbort.then(() => ({ source: "aborted" as const })),
      ]);
      if (first.source === "aborted") {
        cancelRemoteAsk(requestId);
        dialogOptions?.signal?.removeEventListener("abort", onParentAbort);
        return undefined;
      }
      if (first.source === "remote") {
        dialogOptions?.signal?.removeEventListener("abort", onParentAbort);
        return remoteResult(first.outcome);
      }

      const localAbort = new AbortController();
      const localSignal = dialogOptions?.signal
        ? AbortSignal.any([dialogOptions.signal, localAbort.signal])
        : localAbort.signal;
      const localDialogOptions: ExtensionUIDialogOptions = { ...dialogOptions, signal: localSignal };
      delete localDialogOptions.timeout;
      delete localDialogOptions.onTimeout;
      delete localDialogOptions.onTimeoutStart;
      delete localDialogOptions.onTimeoutReset;
      const local = localAskDialog(questions, localDialogOptions).then((value) => ({
        source: "local" as const,
        value,
      }));
      const winner = await Promise.race([
        local,
        remote.then((outcome) => ({ source: "remote" as const, outcome })),
        parentAbort.then(() => ({ source: "aborted" as const })),
      ]);
      dialogOptions?.signal?.removeEventListener("abort", onParentAbort);
      if (winner.source === "aborted") {
        localAbort.abort();
        cancelRemoteAsk(requestId);
        return undefined;
      }
      if (winner.source === "local") {
        cancelRemoteAsk(requestId);
        return winner.value;
      }
      localAbort.abort();
      return remoteResult(winner.outcome);
    };
  };

  const sessionSnapshot = (ctx: ExtensionContext) => {
    const snapshotToolCallTracker = new ExtensionToolCallTracker();
    producerReadImageResolver = createOwnReadImageResolver(TRANSCRIPT_IMAGE_SESSION_MAX_BYTES);
    const messages = ctx.sessionManager
      .getBranch()
      .slice(-200)
      .map((entry) => SessionEntrySchema.safeParse(entry))
      .filter((entry) => entry.success)
      .map((entry) => normalizeMessage(entry.data.message, false, entry.data.id, snapshotToolCallTracker))
      .filter((message) => message !== null)
      .slice(-200);
    const sessionId = ctx.sessionManager.getSessionId();
    const boundedMessages = boundExtensionTranscriptMessages(messages);
    messages.splice(0, messages.length, ...boundedMessages);
    retainedMessagesBySession.set(
      sessionId,
      new Map(boundedMessages.map((message) => [message.id, message])),
    );
    const now = new Date().toISOString();
    const createdAt = sessionCreatedAt.get(sessionId) ?? messages[0]?.timestamp ?? now;
    sessionCreatedAt.set(sessionId, createdAt);
    const model = ctx.models.current();
    return {
      id: sessionId,
      source: "extension" as const,
      name: ctx.sessionManager.getSessionName() ?? null,
      cwd: ctx.cwd,
      status: ctx.isIdle() ? (ctx.hasPendingMessages() ? "waiting" : "idle") : "running",
      connected: true,
      model: model ? `${model.provider}/${model.id}` : null,
      effort: pi.getThinkingLevel() ?? null,
      availableModels: getSessionModelOptions(
        ctx.models.list(),
        typeof ctx.models.resolve === "function"
          ? (role) => {
              const roleModel = ctx.models.resolve(role.startsWith("@") ? role : `@${role}`);
              return roleModel ? { provider: roleModel.provider, id: roleModel.id } : undefined;
            }
          : undefined,
      ),
      contextPercent: normalizeContextPercent(ctx),
      createdAt,
      lastActivity: now,
      capabilities: ["prompt", "steer", "follow_up", "abort", "resume", "model", "effort"] as const,
      messages,
      sessionPath: ctx.sessionManager.getSessionFile() ?? null,
      skillCommands: getSkillCommands(pi.getCommands()),
    };
  };

  const register = (): void => {
    if (!context) return;
    send({ type: "register", session: sessionSnapshot(context) });
  };

  const connect = (): void => {
    if (
      !active ||
      !context ||
      socket?.readyState === WebSocket.CONNECTING ||
      socket?.readyState === WebSocket.OPEN
    )
      return;
    const url = process.env.OMP_REMOTE_EXTENSION_URL ?? DEFAULT_EXTENSION_URL;
    const nextSocket = new WebSocket(url);
    socket = nextSocket;
    nextSocket.addEventListener("open", register);
    nextSocket.addEventListener("message", async (event) => {
      const command: ExtensionCommand | null = (() => {
        try {
          const parsed = CommandSchema.parse(JSON.parse(String(event.data)));
          const canonical: ExtensionCommand = parsed;
          return canonical;
        } catch {
          return null;
        }
      })();
      if (!command) return;
      if (
        command.command === "ask_admitted" ||
        command.command === "ask_response" ||
        command.command === "ask_unavailable"
      ) {
        const pending = pendingRemoteAsks.get(command.requestId);
        if (!pending) return;
        if (command.command === "ask_admitted") {
          pending.admit();
          return;
        }
        if (command.command === "ask_unavailable") {
          pending.settle({ type: "unavailable" });
          return;
        }
        const response: AskResponse = command.response;
        const parsedResponse = normalizeRemoteAskResponse(response);
        if (!parsedResponse) return;
        pending.settle(parsedResponse);
        return;
      }
      if (!context) return;
      try {
        if (command.command === "abort") context.abort();
        else if (command.command === "prompt") await pi.sendUserMessage(command.text);
        else if (command.command === "steer") {
          await pi.sendUserMessage(command.text, { deliverAs: "steer" });
        } else if (command.command === "follow_up") {
          await pi.sendUserMessage(command.text, { deliverAs: "followUp" });
        } else if (command.command === "set_model") {
          const model = context.models.resolve(command.model);
          if (!model) throw new Error(`Model ${command.model} is not available`);
          if (!(await pi.setModel(model))) throw new Error(`Model ${command.model} is not authenticated`);
          register();
        } else if (command.command === "set_effort") {
          pi.setThinkingLevel(command.effort as ExtensionThinkingLevel);
          register();
        }
        send({ type: "command_result", requestId: command.requestId, ok: true, error: null });
      } catch (error) {
        send({
          type: "command_result",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    nextSocket.addEventListener("close", () => {
      if (socket === nextSocket) socket = undefined;
      loseRemoteAsks();
      if (active && context) context.setTimeout(connect, RECONNECT_DELAY_MS);
    });
    nextSocket.addEventListener("error", () => nextSocket.close());
  };

  const emitLifecycle = (
    event: "agent_start" | "agent_end" | "message_start" | "message_update" | "message_end",
    message: unknown,
    streaming: boolean,
  ): void => {
    if (!context) return;
    const sessionId = context.sessionManager.getSessionId();
    const retained = retainedMessagesBySession.get(sessionId);
    const replacementId =
      typeof message === "object" && message !== null && "id" in message && typeof message.id === "string"
        ? message.id
        : activeMessageId;
    let retainedBytes = 0;
    for (const [retainedId, retainedMessage] of retained ?? []) {
      if (retainedId === replacementId || !retainedMessage.images) continue;
      for (const image of retainedMessage.images) retainedBytes += getTranscriptImageByteLength(image);
    }
    producerReadImageResolver = createOwnReadImageResolver(
      Math.max(0, TRANSCRIPT_IMAGE_SESSION_MAX_BYTES - retainedBytes),
    );
    const nextMessage = message ? normalizeMessage(message, streaming, activeMessageId) : null;
    const normalized = nextMessage ? boundLiveMessage(sessionId, nextMessage) : null;
    const model = context.models.current();
    send({
      type: "event",
      sessionId: context.sessionManager.getSessionId(),
      event,
      message: normalized,
      name: context.sessionManager.getSessionName() ?? null,
      model: model ? `${model.provider}/${model.id}` : null,
      contextPercent: normalizeContextPercent(context),
      effort: pi.getThinkingLevel() ?? null,
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (rpcMode && (!sessionFile?.endsWith(".jsonl") || !existsSync(`${dirname(sessionFile)}.jsonl`))) return;
    context = ctx;
    active = true;
    installAskRelay(ctx);
    connect();
    ctx.setInterval(() => {
      const currentContext = context;
      if (!currentContext) return;
      const model = currentContext.models.current();
      send({
        type: "heartbeat",
        sessionId: currentContext.sessionManager.getSessionId(),
        name: currentContext.sessionManager.getSessionName() ?? null,
        model: model ? `${model.provider}/${model.id}` : null,
        contextPercent: normalizeContextPercent(currentContext),
        effort: pi.getThinkingLevel() ?? null,
        availableModels: getSessionModelOptions(
          currentContext.models.list(),
          typeof currentContext.models.resolve === "function"
            ? (role) => {
                const roleModel = currentContext.models.resolve(role.startsWith("@") ? role : `@${role}`);
                return roleModel ? { provider: roleModel.provider, id: roleModel.id } : undefined;
              }
            : undefined,
        ),
        idle: currentContext.isIdle(),
        skillCommands: getSkillCommands(pi.getCommands()),
      });
    }, HEARTBEAT_INTERVAL_MS);
  });

  pi.on("session_switch", async (_event, ctx) => {
    loseRemoteAsks();
    context = ctx;
    installAskRelay(ctx);
    register();
  });
  pi.on("agent_start", async (_event, ctx) => {
    context = ctx;
    emitLifecycle("agent_start", null, false);
  });
  pi.on("agent_end", async (_event, ctx) => {
    context = ctx;
    emitLifecycle("agent_end", null, false);
  });
  pi.on("message_start", async (event, ctx) => {
    context = ctx;
    activeMessageId = `extension-message-${++messageSequence}`;
    emitLifecycle("message_start", event.message, true);
  });
  pi.on("message_update", async (event, ctx) => {
    context = ctx;
    emitLifecycle("message_update", event.message, true);
  });
  pi.on("message_end", async (event, ctx) => {
    context = ctx;
    emitLifecycle("message_end", event.message, false);
    activeMessageId = undefined;
  });
  pi.on("session_shutdown", async () => {
    active = false;
    loseRemoteAsks();
    if (askRelay) askRelay.context.ui.askDialog = askRelay.nativeAskDialog;
    askRelay = undefined;
    socket?.close();
    socket = undefined;
    context = undefined;
  });
}
