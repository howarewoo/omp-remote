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
  })
  .passthrough();
const CanonicalReadToolCallSchema = z
  .object({
    type: z.literal("toolCall"),
    id: z.unknown().optional(),
    toolCallId: z.unknown().optional(),
    name: z.unknown().optional(),
    toolName: z.unknown().optional(),
    arguments: z.object({ path: z.unknown() }).passthrough(),
  })
  .passthrough();
const ReadTargetObservationSchema = z
  .object({
    role: z.unknown(),
    content: z.unknown().optional(),
    toolCallId: z.unknown().optional(),
  })
  .passthrough();

export class ReadTargetTracker {
  readonly #targets = new Map<string, string>();

  capture(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const parsed = CanonicalReadToolCallSchema.safeParse(part);
      if (!parsed.success) continue;
      const toolCallId = typeof parsed.data.toolCallId === "string" ? parsed.data.toolCallId : parsed.data.id;
      const toolName = typeof parsed.data.toolName === "string" ? parsed.data.toolName : parsed.data.name;
      const target = normalizeReadTarget(parsed.data.arguments.path);
      if (toolName === "read" && typeof toolCallId === "string" && toolCallId && target) {
        this.#targets.set(toolCallId, target);
      }
    }
  }
  resolve(toolCallId: unknown, consume = false): string | undefined {
    if (typeof toolCallId !== "string") return undefined;
    const target = this.#targets.get(toolCallId);
    if (consume) this.#targets.delete(toolCallId);
    return target;
  }

  observe(raw: unknown): void {
    const parsed = ReadTargetObservationSchema.safeParse(raw);
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
  readTargetTracker?: ReadTargetTracker;
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
  if (data.role === "assistant") options.readTargetTracker?.capture(data.content);
  const toolName = typeof data.toolName === "string" && data.toolName.trim() ? data.toolName : undefined;
  const readTarget =
    data.role === "toolResult" && toolName === "read"
      ? (options.readTargetTracker?.resolve(data.toolCallId, !streaming) ??
        extractCanonicalReadTarget(data.details))
      : undefined;
  const canonicalDiff =
    data.role === "toolResult" &&
    toolName === "edit" &&
    data.isError === false &&
    typeof data.details === "object" &&
    data.details !== null &&
    "diff" in data.details &&
    typeof data.details.diff === "string"
      ? data.details.diff
      : undefined;
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

function extractCanonicalReadTarget(details: unknown): string | undefined {
  const parsed = CanonicalReadDetailsSchema.safeParse(details);
  if (!parsed.success) return undefined;

  return normalizeReadTarget(parsed.data.meta?.source?.value) ?? normalizeReadTarget(parsed.data.path);
}

function normalizeReadTarget(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const target = value.trim();
  return target && target.length <= 10_000 && !/[\0\r\n]/.test(target) ? target : undefined;
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
