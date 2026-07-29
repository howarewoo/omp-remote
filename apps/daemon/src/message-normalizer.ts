import type { TranscriptMessage } from "@omp-remote/protocol";
import { z } from "zod";

const RawMessageSchema = z
  .object({
    id: z.string().optional(),
    role: z.string(),
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
    ]),
    timestamp: z.union([z.string(), z.number()]).optional(),
    toolName: z.unknown().optional(),
    details: z.unknown().optional(),
    isError: z.unknown().optional(),
  })
  .passthrough();

type FallbackId = string | ((text: string, timestamp: string) => string);

interface NormalizeRawMessageOptions {
  timestamp?: string;
  omitEmptyText?: boolean;
  maxTextLength?: number;
  ignoreRawId?: boolean;
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
  const toolName = typeof data.toolName === "string" && data.toolName.trim() ? data.toolName : undefined;
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
  if (options.omitEmptyText && !fullText) return null;

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
  };
}

function extractText(content: string | Array<{ type: string; text?: string | undefined }>): string {
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
