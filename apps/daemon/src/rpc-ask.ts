import type { AskRequest } from "@omp-remote/protocol";
import { z } from "zod";

const RpcAskRequestSchema = z.discriminatedUnion("method", [
  z.object({
    type: z.literal("extension_ui_request"),
    id: z.string().min(1),
    method: z.literal("select"),
    title: z.string().min(1),
    options: z.array(z.string()).min(1),
    timeout: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal("extension_ui_request"),
    id: z.string().min(1),
    method: z.literal("editor"),
    title: z.string().min(1),
    prefill: z.string().optional(),
  }),
  z.object({
    type: z.literal("extension_ui_request"),
    id: z.string().min(1),
    method: z.literal("cancel"),
    targetId: z.string().min(1),
  }),
]);

export type RpcAskEvent = { type: "request"; request: AskRequest } | { type: "cancel"; requestId: string };

export function normalizeRpcAskEvent(
  sessionId: string,
  frame: unknown,
  receivedAt = Date.now(),
): RpcAskEvent | null {
  const parsed = RpcAskRequestSchema.safeParse(frame);
  if (!parsed.success) return null;
  if (parsed.data.method === "cancel") {
    return { type: "cancel", requestId: parsed.data.targetId };
  }

  const timeout = parsed.data.method === "select" ? parsed.data.timeout : undefined;
  return {
    type: "request",
    request: {
      sessionId,
      requestId: parsed.data.id,
      kind: parsed.data.method === "select" ? "select" : "text",
      title: parsed.data.title,
      options: parsed.data.method === "select" ? parsed.data.options : [],
      initialValue: parsed.data.method === "editor" ? (parsed.data.prefill ?? null) : null,
      expiresAt: timeout === undefined ? null : new Date(receivedAt + timeout).toISOString(),
    },
  };
}
