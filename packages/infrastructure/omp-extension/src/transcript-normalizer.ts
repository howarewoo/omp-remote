import {
  boundTranscriptImageBudget,
  type TranscriptImage,
  type TranscriptMessage,
} from "@omp-remote/protocol";
import { type ExtensionToolDetails, formatExtensionToolTitle } from "./tool-title.js";

type ExtensionTranscriptMessage = TranscriptMessage;

export function boundExtensionTranscriptMessages(
  messages: readonly ExtensionTranscriptMessage[],
): ExtensionTranscriptMessage[] {
  return boundTranscriptImageBudget(messages);
}

type TranscriptRole = TranscriptMessage["role"];

type FallbackId = string | (() => string);

type TrackedToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

type RawExtensionMessage = {
  id?: unknown;
  role: string;
  content:
    | string
    | Array<{
        type: string;
        text?: string;
        thinking?: string;
        data?: unknown;
        mimeType?: unknown;
      }>;
  timestamp?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  details?: unknown;
  isError?: unknown;
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
  const lifecycle =
    message.role === "toolResult"
      ? streaming
        ? ({ state: "running" } as const)
        : message.isError === true
          ? ({ state: "error" } as const)
          : ({ state: "success" } as const)
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
    ...(lifecycle ? { lifecycle } : {}),
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

function isContent(
  value: unknown,
): value is string | Array<{ type: string; text?: string; thinking?: string }> {
  return (
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.every(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          typeof part.type === "string" &&
          (!("text" in part) || part.text === undefined || typeof part.text === "string") &&
          (!("thinking" in part) || part.thinking === undefined || typeof part.thinking === "string"),
      ))
  );
}

function extractText(content: string | Array<{ type: string; text?: string; thinking?: string }>): string {
  if (typeof content === "string") return content;
  let text = "";
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text;
    } else if (part.type === "thinking") {
      if (typeof part.thinking === "string") {
        text += part.thinking;
      } else if (typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  return text;
}

function normalizeBoundedSingleLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 10_000 && !/[\0\r\n]/.test(normalized) ? normalized : undefined;
}

function normalizeRole(role: string): TranscriptRole {
  if (role === "toolResult") return "tool";
  return role === "user" || role === "assistant" || role === "tool" ? role : "system";
}
