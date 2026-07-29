import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const DEFAULT_EXTENSION_URL = "ws://127.0.0.1:4387/extension";
const RECONNECT_DELAY_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

export default function ompRemoteExtension(pi: ExtensionAPI): void {
  const { z } = pi.zod;
  const CommandSchema = z.discriminatedUnion("command", [
    z.object({
      requestId: z.string(),
      command: z.enum(["prompt", "steer", "follow_up"]),
      text: z.string().min(1),
    }),
    z.object({ requestId: z.string(), command: z.literal("abort") }),
  ]);
  const MessageSchema = z
    .object({
      id: z.string().optional(),
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
      ]),
      timestamp: z.union([z.string(), z.number()]).optional(),
    })
    .passthrough();
  const SessionEntrySchema = z
    .object({ id: z.string(), type: z.literal("message"), message: z.unknown() })
    .passthrough();
  const sessionCreatedAt = new Map<string, string>();

  let context: ExtensionContext | undefined;
  let socket: WebSocket | undefined;
  let active = false;
  let activeMessageId: string | undefined;
  let messageSequence = 0;

  const normalizeContextPercent = (ctx: ExtensionContext): number | null => {
    const percent = ctx.getContextUsage()?.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
    return Math.max(0, Math.min(100, percent <= 1 ? percent * 100 : percent));
  };

  const normalizeMessage = (raw: unknown, streaming: boolean, fallbackId?: string) => {
    const parsed = MessageSchema.safeParse(raw);
    if (!parsed.success) return null;
    const text =
      typeof parsed.data.content === "string"
        ? parsed.data.content
        : parsed.data.content
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("");
    const role = ["user", "assistant", "tool", "system"].includes(parsed.data.role)
      ? parsed.data.role
      : "system";
    const rawTimestamp = parsed.data.timestamp;
    const timestamp =
      typeof rawTimestamp === "number"
        ? new Date(rawTimestamp).toISOString()
        : typeof rawTimestamp === "string"
          ? rawTimestamp
          : new Date().toISOString();
    return {
      id: parsed.data.id ?? fallbackId ?? `extension-message-${++messageSequence}`,
      role,
      text,
      timestamp,
      streaming,
    } as const;
  };

  const send = (frame: object): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const sessionSnapshot = (ctx: ExtensionContext) => {
    const messages = ctx.sessionManager
      .getBranch()
      .map((entry) => SessionEntrySchema.safeParse(entry))
      .filter((entry) => entry.success)
      .map((entry) => normalizeMessage(entry.data.message, false, entry.data.id))
      .filter((message) => message !== null)
      .slice(-200);
    const sessionId = ctx.sessionManager.getSessionId();
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
      contextPercent: normalizeContextPercent(ctx),
      createdAt,
      lastActivity: now,
      capabilities: ["prompt", "steer", "follow_up", "abort", "resume"] as const,
      messages,
      sessionPath: ctx.sessionManager.getSessionFile() ?? null,
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
      const command = (() => {
        try {
          return CommandSchema.parse(JSON.parse(String(event.data)));
        } catch {
          return null;
        }
      })();
      if (!command) return;
      if (!context) return;
      try {
        if (command.command === "abort") context.abort();
        else if (command.command === "prompt") await pi.sendUserMessage(command.text);
        else if (command.command === "steer") {
          await pi.sendUserMessage(command.text, { deliverAs: "steer" });
        } else {
          await pi.sendUserMessage(command.text, { deliverAs: "followUp" });
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
    const normalized = message ? normalizeMessage(message, streaming, activeMessageId) : null;
    const model = context.models.current();
    send({
      type: "event",
      sessionId: context.sessionManager.getSessionId(),
      event,
      message: normalized,
      name: context.sessionManager.getSessionName() ?? null,
      model: model ? `${model.provider}/${model.id}` : null,
      contextPercent: normalizeContextPercent(context),
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    active = true;
    connect();
    ctx.setInterval(() => {
      if (!context) return;
      const model = context.models.current();
      send({
        type: "heartbeat",
        sessionId: context.sessionManager.getSessionId(),
        name: context.sessionManager.getSessionName() ?? null,
        model: model ? `${model.provider}/${model.id}` : null,
        contextPercent: normalizeContextPercent(context),
        idle: context.isIdle(),
      });
    }, HEARTBEAT_INTERVAL_MS);
  });

  pi.on("session_switch", async (_event, ctx) => {
    context = ctx;
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
    socket?.close();
    socket = undefined;
    context = undefined;
  });
}
