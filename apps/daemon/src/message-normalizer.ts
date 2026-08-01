import { SkillCommandSchema, type SkillCommand, type TranscriptMessage } from "@omp-remote/protocol";
import { z } from "zod";

const RawContentPartSchema = z.object({ type: z.string(), text: z.string().optional() }).passthrough();
type RawMessageContent = string | z.infer<typeof RawContentPartSchema>[];

const RawMessageSchema = z
  .object({
    id: z.string().optional(),
    role: z.string(),
    content: z.union([z.string(), z.array(RawContentPartSchema)]),
    timestamp: z.union([z.string(), z.number()]).optional(),
    toolName: z.unknown().optional(),
    toolCallId: z.unknown().optional(),
    details: z.unknown().optional(),
    isError: z.unknown().optional(),
  })
  .passthrough();

const RawSkillCommandSchema = SkillCommandSchema.extend({ source: z.literal("skill") }).passthrough();
const CanonicalReadDetailsSchema = z
  .object({
    meta: z
      .object({
        source: z.object({ value: z.unknown() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    path: z.unknown().optional(),
    resolvedPath: z.unknown().optional(),
  })
  .passthrough();
const CanonicalToolCallSchema = z
  .object({
    type: z.literal("toolCall"),
    id: z.unknown().optional(),
    toolCallId: z.unknown().optional(),
    name: z.unknown().optional(),
    toolName: z.unknown().optional(),
    arguments: z.object({}).catchall(z.unknown()),
  })
  .passthrough();
const ToolCallObservationSchema = z
  .object({
    role: z.unknown(),
    content: z.unknown().optional(),
    toolCallId: z.unknown().optional(),
  })
  .passthrough();
const CanonicalEditDetailsSchema = z
  .object({
    path: z.unknown().optional(),
    diff: z.unknown().optional(),
    perFileResults: z.array(z.object({ path: z.unknown().optional() }).passthrough()).optional(),
  })
  .passthrough();
const CanonicalGrepDetailsSchema = z
  .object({
    matchCount: z.number().int().nonnegative().optional(),
    fileCount: z.number().int().nonnegative().optional(),
    scopePath: z.unknown().optional(),
  })
  .passthrough();
const CanonicalHubDetailsSchema = z
  .object({
    to: z.unknown().optional(),
    receipts: z
      .array(
        z
          .object({
            to: z.unknown(),
            outcome: z.enum(["injected", "woken", "revived", "failed"]),
          })
          .passthrough(),
      )
      .optional(),
    waited: z
      .object({
        from: z.unknown(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

type TrackedToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

export class ToolCallTracker {
  readonly #calls = new Map<string, TrackedToolCall>();

  capture(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const parsed = CanonicalToolCallSchema.safeParse(part);
      if (!parsed.success) continue;
      const toolCallId = typeof parsed.data.toolCallId === "string" ? parsed.data.toolCallId : parsed.data.id;
      const toolName = typeof parsed.data.toolName === "string" ? parsed.data.toolName : parsed.data.name;
      if (typeof toolCallId === "string" && toolCallId && typeof toolName === "string" && toolName) {
        this.#calls.set(toolCallId, { toolName, arguments: parsed.data.arguments });
      }
    }
  }

  resolve(toolCallId: unknown, consume = false): TrackedToolCall | undefined {
    if (typeof toolCallId !== "string") return undefined;
    const toolCall = this.#calls.get(toolCallId);
    if (consume) this.#calls.delete(toolCallId);
    return toolCall;
  }

  observe(raw: unknown): void {
    const parsed = ToolCallObservationSchema.safeParse(raw);
    if (!parsed.success) return;
    if (parsed.data.role === "assistant") {
      this.capture(parsed.data.content);
    } else if (parsed.data.role === "toolResult") {
      this.resolve(parsed.data.toolCallId, true);
    }
  }
}

type FallbackId = string | ((text: string, timestamp: string) => string);

interface NormalizeRawMessageOptions {
  timestamp?: string;
  omitEmptyText?: boolean;
  maxTextLength?: number;
  ignoreRawId?: boolean;
  toolCallTracker?: ToolCallTracker;
}

export function normalizeRawMessage(
  raw: unknown,
  streaming: boolean,
  fallbackId: FallbackId,
  options: NormalizeRawMessageOptions = {},
): TranscriptMessage | null {
  const parsed = RawMessageSchema.safeParse(raw);
  if (!parsed.success) return null;

  const { data } = parsed;
  if (data.role === "assistant") options.toolCallTracker?.capture(data.content);
  const toolName = typeof data.toolName === "string" && data.toolName.trim() ? data.toolName : undefined;
  const resolvedToolCall =
    data.role === "toolResult" ? options.toolCallTracker?.resolve(data.toolCallId, !streaming) : undefined;
  const toolCall = resolvedToolCall?.toolName === toolName ? resolvedToolCall : undefined;
  const isReadToolResult = data.role === "toolResult" && toolName === "read";
  const canonicalReadDetails = isReadToolResult ? CanonicalReadDetailsSchema.safeParse(data.details) : null;
  const trackedReadTarget = normalizeBoundedSingleLine(toolCall?.arguments.path);
  const readSourcePath =
    canonicalReadDetails?.success === true
      ? normalizeBoundedSingleLine(canonicalReadDetails.data.meta?.source?.value)
      : undefined;
  const readTarget = isReadToolResult
    ? (trackedReadTarget ??
      readSourcePath ??
      (canonicalReadDetails?.success
        ? normalizeBoundedSingleLine(canonicalReadDetails.data.path)
        : undefined))
    : undefined;
  const readResolvedPath =
    canonicalReadDetails?.success === true
      ? (normalizeBoundedSingleLine(canonicalReadDetails.data.resolvedPath) ??
        (trackedReadTarget?.startsWith("skill://") ? readSourcePath : undefined))
      : undefined;
  const canonicalEditDetails =
    data.role === "toolResult" && toolName === "edit"
      ? CanonicalEditDetailsSchema.safeParse(data.details)
      : null;
  const appliedDiff =
    canonicalEditDetails?.success === true && typeof canonicalEditDetails.data.diff === "string"
      ? canonicalEditDetails.data.diff
      : undefined;
  const canonicalDiff = data.isError === false ? appliedDiff : undefined;
  const isCanonicalEditDiff = canonicalDiff !== undefined;
  const fullText = canonicalDiff ?? extractText(data.content);
  if (!fullText && (options.omitEmptyText || data.role !== "toolResult")) return null;

  const timestamp = options.timestamp ?? normalizeRawTimestamp(data.timestamp);
  const resolvedFallbackId = typeof fallbackId === "function" ? fallbackId(fullText, timestamp) : fallbackId;
  const id = options.ignoreRawId ? resolvedFallbackId : (data.id ?? resolvedFallbackId);
  const text =
    options.maxTextLength !== undefined && fullText.length > options.maxTextLength
      ? `${fullText.slice(0, options.maxTextLength)}…`
      : fullText;
  const toolTitle =
    data.role === "toolResult"
      ? formatToolTitle(toolName, toolCall?.arguments, data.details, appliedDiff)
      : undefined;
  const role =
    data.role === "toolResult"
      ? "tool"
      : data.role === "user" || data.role === "assistant" || data.role === "tool"
        ? data.role
        : "system";

  return {
    id,
    role,
    text,
    timestamp,
    streaming,
    presentation: isCanonicalEditDiff ? "diff" : "text",
    ...(toolName ? { toolName } : {}),
    ...(readTarget ? { readTarget } : {}),
    ...(readResolvedPath ? { readResolvedPath } : {}),
    ...(toolTitle ? { toolTitle } : {}),
  };
}

export function normalizeSkillCommands(raw: unknown): SkillCommand[] {
  if (!Array.isArray(raw)) return [];
  const commands: SkillCommand[] = [];
  for (const command of raw) {
    const parsed = RawSkillCommandSchema.safeParse(command);
    if (!parsed.success) continue;
    commands.push({
      name: parsed.data.name,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
    });
  }
  return commands;
}

function normalizeBoundedSingleLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 10_000 && !/[\0\r\n]/.test(normalized) ? normalized : undefined;
}

function formatToolTitle(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
  details: unknown,
  canonicalDiff: string | undefined,
): string | undefined {
  if (toolName === "bash") {
    const command = normalizeHeaderValue(args?.command);
    return command ? `Bash: ${command}` : undefined;
  }
  if (toolName === "edit") {
    const parsedDetails = CanonicalEditDetailsSchema.safeParse(details);
    const inputPaths = extractEditPaths(args?.input);
    const detailPaths = parsedDetails.success
      ? [
          ...(parsedDetails.data.perFileResults ?? []).map((result) =>
            normalizeBoundedSingleLine(result.path),
          ),
          normalizeBoundedSingleLine(parsedDetails.data.path),
        ].filter((path): path is string => Boolean(path))
      : [];
    const paths = inputPaths.length > 0 ? inputPaths : detailPaths;
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
    const parsedDetails = CanonicalGrepDetailsSchema.safeParse(details);
    const matchCount = parsedDetails.success ? parsedDetails.data.matchCount : undefined;
    const fileCount = parsedDetails.success ? parsedDetails.data.fileCount : undefined;
    const scope = formatScopePath(
      normalizeBoundedSingleLine(args?.path) ??
        (parsedDetails.success ? normalizeBoundedSingleLine(parsedDetails.data.scopePath) : undefined),
    );
    const countLabel =
      matchCount === undefined || fileCount === undefined
        ? ""
        : ` ${matchCount} ${matchCount === 1 ? "match" : "matches"} · ${fileCount} ${
            fileCount === 1 ? "file" : "files"
          }`;
    return `Grep: ${pattern}${countLabel}${scope ? ` · in ${scope}` : ""}`;
  }
  if (toolName === "hub") {
    const parsedDetails = CanonicalHubDetailsSchema.safeParse(details);
    const incomingFrom =
      parsedDetails.success && parsedDetails.data.waited
        ? normalizeHeaderValue(parsedDetails.data.waited.from)
        : undefined;
    if (incomingFrom) return `✉ IRC ⟵ ${incomingFrom}`;

    if (args?.op !== "send") return undefined;
    const target =
      normalizeHeaderValue(args.to) ??
      (parsedDetails.success ? normalizeHeaderValue(parsedDetails.data.to) : undefined);
    if (!target) return undefined;
    const receipt = parsedDetails.success
      ? parsedDetails.data.receipts?.find((candidate) => candidate.to === target)
      : undefined;
    return `IRC ➤ ${target}${receipt ? ` ${receipt.outcome}` : ""}`;
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

function formatScopePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

function normalizeHeaderValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= 10_000 ? normalized : undefined;
}

function extractText(content: RawMessageContent): string {
  if (typeof content === "string") return content;
  let text = "";
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text;
}

function normalizeRawTimestamp(timestamp: string | number | undefined): string {
  if (typeof timestamp === "number") return new Date(timestamp).toISOString();
  return typeof timestamp === "string" ? timestamp : new Date().toISOString();
}
