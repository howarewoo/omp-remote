import type { AskRequest, AskResponse } from "@omp-remote/protocol";
import { z } from "zod";

export type AskInactivityTimeout = {
  sessionId: string;
  requestId: string;
  durationMs: number;
  handle: NodeJS.Timeout;
};

function scheduleInactivityTimeout(durationMs: number, onExpire: () => void): NodeJS.Timeout {
  const handle = setTimeout(onExpire, durationMs);
  handle.unref();
  return handle;
}

export function createAskInactivityTimeout(
  sessionId: string,
  requestId: string,
  expiresAt: string | null,
  onExpire: () => void,
  now = Date.now(),
): AskInactivityTimeout | undefined {
  if (!expiresAt) return undefined;
  const durationMs = Math.max(0, Date.parse(expiresAt) - now);
  return {
    sessionId,
    requestId,
    durationMs,
    handle: scheduleInactivityTimeout(durationMs, onExpire),
  };
}

export function resetAskInactivityTimeout(
  timeout: AskInactivityTimeout | undefined,
  sessionId: string,
  requestId: string,
  onExpire: () => void,
): boolean {
  if (!timeout || timeout.sessionId !== sessionId || timeout.requestId !== requestId) {
    return false;
  }
  clearTimeout(timeout.handle);
  timeout.handle = scheduleInactivityTimeout(timeout.durationMs, onExpire);
  return true;
}

export function clearAskInactivityTimeout(timeout: AskInactivityTimeout | undefined): void {
  if (timeout) clearTimeout(timeout.handle);
}

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

export function isAskResponseValid(request: AskRequest, response: AskResponse): boolean {
  if ("cancelled" in response) return request.kind !== "rich" || response.timedOut !== true;
  if (request.kind === "select") return "value" in response && request.options.includes(response.value);
  if (request.kind === "text") return "value" in response;
  if ("value" in response) return false;
  if (response.kind === "chat") return true;
  if (response.results.length !== request.questions.length) return false;
  return response.results.every((result, index) => {
    const question = request.questions[index];
    if (!question || result.id !== question.id || result.question !== question.question) return false;
    if (result.multi !== (question.multi ?? false)) return false;
    if (
      result.options.length !== question.options.length ||
      result.options.some((option, optionIndex) => option !== question.options[optionIndex]?.label)
    )
      return false;
    if (result.selectedOptions.some((option) => !result.options.includes(option))) return false;
    const hasCustomInput = Boolean(result.customInput?.trim());
    if (!result.timedOut && result.selectedOptions.length === 0 && !hasCustomInput) return false;
    if (!result.multi) {
      if (result.selectedOptions.length > 1) return false;
      if (result.selectedOptions.length === 1 && hasCustomInput) return false;
    }
    return true;
  });
}

export function ownsCurrentExtensionSocket<Socket>(
  socket: Socket,
  sessionId: string,
  sessionBySocket: ReadonlyMap<Socket, string>,
  socketBySession: ReadonlyMap<string, Socket>,
): boolean {
  return sessionBySocket.get(socket) === sessionId && socketBySession.get(sessionId) === socket;
}

export function releaseCurrentExtensionSocket<Socket>(
  socket: Socket,
  sessionBySocket: Map<Socket, string>,
  socketBySession: Map<string, Socket>,
): string | null {
  const sessionId = sessionBySocket.get(socket);
  if (!sessionId) return null;
  sessionBySocket.delete(socket);
  if (socketBySession.get(sessionId) !== socket) return null;
  socketBySession.delete(sessionId);
  return sessionId;
}

export function expireExtensionAsk(
  sessionId: string,
  requestId: string,
  sendResponse: (sessionId: string, requestId: string, response: AskResponse) => void,
  clearPending: (sessionId: string, requestId: string) => void,
): void {
  sendResponse(sessionId, requestId, { cancelled: true, timedOut: true });
  clearPending(sessionId, requestId);
}
