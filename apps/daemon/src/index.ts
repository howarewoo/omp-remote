import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { createLogger } from "@omp-remote/observability";
import { type RpcFrame, RpcSession } from "@omp-remote/omp-rpc";
import {
  BrowserCommandSchema,
  ExtensionFrameSchema,
  SessionCatalogPageSchema,
  SessionTranscriptResponseSchema,
  type ServerFrame,
  type Session,
  type TranscriptMessage,
} from "@omp-remote/protocol";
import { SessionRegistry } from "@omp-remote/sessions/services";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { z } from "zod";
import { resolveSessionRoots, SessionCatalog } from "./session-catalog.js";

const MAX_MESSAGES = 200;
const logger = createLogger("omp-remote-daemon");
const EnvironmentSchema = z.object({
  OMP_REMOTE_HOST: z.enum(["127.0.0.1", "::1", "localhost"]).default("127.0.0.1"),
  OMP_REMOTE_PORT: z.coerce.number().int().min(1).max(65_535).default(4387),
  OMP_REMOTE_ORIGIN: z.string().url().optional(),
  OMP_REMOTE_OMP_PATH: z.string().min(1).default("omp"),
});
const RpcStateResponseSchema = z.object({
  type: z.literal("response"),
  command: z.literal("get_state"),
  success: z.literal(true),
  data: z.object({
    sessionId: z.string(),
    sessionName: z.string().nullable().optional(),
    sessionFile: z.string().nullable().optional(),
    model: z.object({ provider: z.string(), id: z.string() }).nullable().optional(),
    isStreaming: z.boolean(),
    queuedMessageCount: z.number().optional(),
    contextUsage: z.object({ percent: z.number() }).nullable().optional(),
  }),
});
const RpcMessageFrameSchema = z.object({
  type: z.enum(["message_start", "message_update", "message_end"]),
  message: z.unknown(),
});
const RpcMessageSchema = z
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
const RpcMessagesResponseSchema = z.object({
  type: z.literal("response"),
  command: z.literal("get_messages"),
  success: z.literal(true),
  data: z.union([z.array(z.unknown()), z.object({ messages: z.array(z.unknown()) })]),
});
const CatalogQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  q: z.string().trim().max(200).default(""),
});
const SessionParamsSchema = z.object({ sessionId: z.string().min(1) });

const environment = EnvironmentSchema.parse(process.env);
const sessionCatalog = new SessionCatalog(
  await resolveSessionRoots(homedir(), process.env.PI_CODING_AGENT_DIR),
);
const initialCatalogDiff = await sessionCatalog.refresh();
const registry = new SessionRegistry();
const browserSockets = new Set<WebSocket>();
const rpcSessions = new Map<string, RpcSession>();
const extensionSockets = new Map<string, WebSocket>();
const extensionSessionBySocket = new Map<WebSocket, string>();
const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

app.get("/healthz", async () => ({
  service: "omp-remote",
  status: "ok",
  sessions: registry.list().length,
  timestamp: new Date().toISOString(),
}));

app.get("/api/sessions", async (request, reply) => {
  const query = CatalogQuerySchema.safeParse(request.query);
  if (!query.success) return reply.code(400).send({ error: "Invalid session catalog query" });
  return SessionCatalogPageSchema.parse(
    sessionCatalog.list({
      offset: query.data.offset,
      limit: query.data.limit,
      query: query.data.q,
    }),
  );
});

app.get("/api/sessions/:sessionId/transcript", async (request, reply) => {
  const params = SessionParamsSchema.safeParse(request.params);
  if (!params.success || !sessionCatalog.get(params.data.sessionId)) {
    return reply.code(404).send({ error: "Session history was not found" });
  }
  try {
    return SessionTranscriptResponseSchema.parse({
      sessionId: params.data.sessionId,
      messages: await sessionCatalog.transcript(params.data.sessionId),
    });
  } catch (error) {
    logger.error("Could not read OMP session transcript", error, { sessionId: params.data.sessionId });
    return reply.code(500).send({ error: "Session history could not be read" });
  }
});

app.get("/ws", { websocket: true }, (socket, request) => {
  if (!originAllowed(request.headers.origin)) {
    socket.close(1008, "Origin is not allowed");
    return;
  }
  browserSockets.add(socket);
  sendFrame(socket, { type: "snapshot", sessions: registry.list() });
  socket.on("message", async (raw) => {
    const command = (() => {
      try {
        return BrowserCommandSchema.parse(JSON.parse(raw.toString()));
      } catch (error) {
        logger.error("Rejected dashboard command", error);
        sendFrame(socket, { type: "error", message: "The dashboard command was not valid." });
        return null;
      }
    })();
    if (!command) return;

    if (command.type === "launch") {
      try {
        await launchRpcSession(command.cwd, command.resume);
        sendFrame(socket, { type: "command_result", requestId: command.requestId, ok: true, error: null });
      } catch (error) {
        logger.error("Failed to launch OMP RPC session", error, { cwd: command.cwd });
        sendFrame(socket, {
          type: "command_result",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "OMP could not start",
        });
      }
      return;
    }

    const rpcSession = rpcSessions.get(command.sessionId);
    if (rpcSession) {
      try {
        const rpcCommand: RpcFrame =
          command.command === "abort"
            ? { type: "abort" }
            : command.command === "follow_up"
              ? { type: "follow_up", message: command.text }
              : { type: command.command, message: command.text };
        await rpcSession.request(rpcCommand);
        sendFrame(socket, { type: "command_result", requestId: command.requestId, ok: true, error: null });
      } catch (error) {
        sendFrame(socket, {
          type: "command_result",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "OMP rejected the command",
        });
      }
      return;
    }

    const extensionSocket = extensionSockets.get(command.sessionId);
    if (extensionSocket?.readyState === WebSocket.OPEN) {
      extensionSocket.send(JSON.stringify(command));
      return;
    }
    sendFrame(socket, {
      type: "command_result",
      requestId: command.requestId,
      ok: false,
      error: "This OMP session is no longer connected.",
    });
  });
  socket.on("close", () => browserSockets.delete(socket));
});

app.get("/extension", { websocket: true }, (socket, request) => {
  if (!isLoopbackAddress(request.ip)) {
    socket.close(1008, "Extensions must connect over loopback");
    return;
  }
  socket.on("message", (raw) => {
    const frame = (() => {
      try {
        return ExtensionFrameSchema.parse(JSON.parse(raw.toString()));
      } catch {
        socket.close(1003, "Invalid extension frame");
        return null;
      }
    })();
    if (!frame) return;

    if (frame.type === "register") {
      const previousSessionId = extensionSessionBySocket.get(socket);
      if (previousSessionId && previousSessionId !== frame.session.id) {
        extensionSockets.delete(previousSessionId);
        markSessionHistorical(previousSessionId);
      }
      extensionSessionBySocket.set(socket, frame.session.id);
      extensionSockets.set(frame.session.id, socket);
      registry.upsert({
        ...frame.session,
        activeSubagents: sessionCatalog.get(frame.session.id)?.activeSubagents ?? [],
      });
    } else if (frame.type === "heartbeat") {
      registry.update(frame.sessionId, {
        connected: true,
        status: frame.idle ? "idle" : "running",
        name: frame.name,
        model: frame.model,
        contextPercent: frame.contextPercent,
        lastActivity: new Date().toISOString(),
      });
    } else if (frame.type === "event") {
      registry.update(frame.sessionId, {
        connected: true,
        ...(frame.event === "agent_start"
          ? { status: "running" as const }
          : frame.event === "agent_end"
            ? { status: "idle" as const }
            : {}),
        name: frame.name,
        model: frame.model,
        contextPercent: frame.contextPercent,
        lastActivity: new Date().toISOString(),
      });
      if (frame.message) registry.appendMessage(frame.sessionId, frame.message);
    } else {
      broadcast({
        type: "command_result",
        requestId: frame.requestId,
        ok: frame.ok,
        error: frame.error,
      });
    }
  });
  socket.on("close", () => {
    const sessionId = extensionSessionBySocket.get(socket);
    if (!sessionId) return;
    extensionSessionBySocket.delete(socket);
    if (extensionSockets.get(sessionId) === socket) extensionSockets.delete(sessionId);
    markSessionHistorical(sessionId);
  });
});

const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler(async (request, reply) => {
    if (
      request.raw.method === "GET" &&
      !request.url.startsWith("/healthz") &&
      !request.url.startsWith("/api/")
    )
      return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Not found" });
  });
}

registry.subscribe((event) => broadcast(event));
await app.listen({ host: environment.OMP_REMOTE_HOST, port: environment.OMP_REMOTE_PORT });
logger.info("OMP Remote daemon listening", {
  host: environment.OMP_REMOTE_HOST,
  port: environment.OMP_REMOTE_PORT,
});
logger.info("OMP session history indexed", { sessions: initialCatalogDiff.upserted.length });
const catalogRefreshTimer = setInterval(() => {
  void sessionCatalog
    .refresh()
    .then((diff) => {
      for (const session of diff.upserted) syncActiveSubagents(session);
    })
    .catch((error) => logger.error("Could not refresh OMP session history", error));
}, 10_000);
catalogRefreshTimer.unref();

async function launchRpcSession(cwd: string, resume: string | null): Promise<Session> {
  const rpc = new RpcSession({
    cwd,
    resume,
    ompPath: environment.OMP_REMOTE_OMP_PATH,
    onStderr: (text) => logger.info("OMP RPC stderr", { text: text.trim().slice(0, 1_000) }),
  });
  let sessionId: string | undefined;
  let messageSequence = 0;
  let activeMessageId: string | undefined;
  rpc.subscribe((frame) => {
    if (!sessionId) return;
    if (frame.type === "agent_start") {
      registry.update(sessionId, { status: "running", lastActivity: new Date().toISOString() });
    } else if (frame.type === "agent_end") {
      registry.update(sessionId, { status: "idle", lastActivity: new Date().toISOString() });
      void refreshRpcState(sessionId, rpc);
    } else if (frame.type === "process_exit") {
      markSessionHistorical(sessionId);
      rpcSessions.delete(sessionId);
    } else {
      const parsed = RpcMessageFrameSchema.safeParse(frame);
      if (!parsed.success) return;
      if (parsed.data.type === "message_start") {
        activeMessageId = `rpc-message-${sessionId}-${++messageSequence}`;
      }
      const message = normalizeRpcMessage(
        parsed.data.message,
        parsed.data.type !== "message_end",
        activeMessageId ?? `rpc-message-${sessionId}-${++messageSequence}`,
      );
      if (message) registry.appendMessage(sessionId, message);
      if (parsed.data.type === "message_end") activeMessageId = undefined;
    }
  });

  const stateResponse = RpcStateResponseSchema.parse(await rpc.start());
  sessionId = stateResponse.data.sessionId;
  if (!sessionId) throw new Error("OMP RPC did not return a session ID");
  const contextPercent = normalizePercent(stateResponse.data.contextUsage?.percent);
  const session: Session = {
    id: sessionId,
    source: "rpc",
    name: stateResponse.data.sessionName ?? null,
    cwd,
    status: stateResponse.data.isStreaming
      ? "running"
      : stateResponse.data.queuedMessageCount
        ? "waiting"
        : "idle",
    connected: true,
    model: stateResponse.data.model
      ? `${stateResponse.data.model.provider}/${stateResponse.data.model.id}`
      : null,
    contextPercent,
    lastActivity: new Date().toISOString(),
    capabilities: ["prompt", "steer", "follow_up", "abort", "resume"],
    messages: [],
    sessionPath: stateResponse.data.sessionFile ?? null,
    activeSubagents: sessionCatalog.get(sessionId)?.activeSubagents ?? [],
  };
  rpcSessions.set(sessionId, rpc);
  registry.upsert(session);

  try {
    const messagesResponse = RpcMessagesResponseSchema.parse(await rpc.request({ type: "get_messages" }));
    const messages = Array.isArray(messagesResponse.data)
      ? messagesResponse.data
      : messagesResponse.data.messages;
    for (const [index, rawMessage] of messages.slice(-MAX_MESSAGES).entries()) {
      const message = normalizeRpcMessage(rawMessage, false, `rpc-history-${sessionId}-${index}`);
      if (message) registry.appendMessage(sessionId, message);
    }
  } catch (error) {
    logger.error("Could not load initial OMP transcript", error, { sessionId });
  }
  return registry.get(sessionId) ?? session;
}

async function refreshRpcState(sessionId: string, rpc: RpcSession): Promise<void> {
  try {
    const response = RpcStateResponseSchema.parse(await rpc.request({ type: "get_state" }));
    registry.update(sessionId, {
      name: response.data.sessionName ?? null,
      model: response.data.model ? `${response.data.model.provider}/${response.data.model.id}` : null,
      contextPercent: normalizePercent(response.data.contextUsage?.percent),
      status: response.data.queuedMessageCount ? "waiting" : response.data.isStreaming ? "running" : "idle",
    });
  } catch (error) {
    logger.error("Could not refresh OMP RPC state", error, { sessionId });
  }
}

function normalizeRpcMessage(raw: unknown, streaming: boolean, fallbackId: string): TranscriptMessage | null {
  const parsed = RpcMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const content = parsed.data.content;
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("");
  const role =
    parsed.data.role === "user" || parsed.data.role === "assistant" || parsed.data.role === "tool"
      ? parsed.data.role
      : "system";
  const rawTimestamp = parsed.data.timestamp;
  return {
    id: parsed.data.id ?? fallbackId,
    role,
    text,
    timestamp:
      typeof rawTimestamp === "number"
        ? new Date(rawTimestamp).toISOString()
        : typeof rawTimestamp === "string"
          ? rawTimestamp
          : new Date().toISOString(),
    streaming,
  };
}

function syncActiveSubagents(catalogSession: Session): void {
  const liveSession = registry.get(catalogSession.id);
  if (!liveSession || activeSubagentsEqual(liveSession.activeSubagents, catalogSession.activeSubagents))
    return;
  registry.update(catalogSession.id, { activeSubagents: catalogSession.activeSubagents });
}

function activeSubagentsEqual(left: Session["activeSubagents"], right: Session["activeSubagents"]): boolean {
  return (
    left.length === right.length &&
    left.every((subagent, index) => {
      const other = right[index];
      return (
        subagent.id === other?.id &&
        subagent.name === other.name &&
        subagent.lastActivity === other.lastActivity
      );
    })
  );
}

function normalizePercent(percent: number | undefined): number | null {
  if (percent === undefined || !Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, percent <= 1 ? percent * 100 : percent));
}

function sendFrame(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function broadcast(frame: ServerFrame): void {
  for (const socket of browserSockets) sendFrame(socket, frame);
}

function markSessionHistorical(sessionId: string): void {
  const current = registry.get(sessionId);
  if (!current) return;
  const historical = sessionCatalog.get(sessionId);
  if (historical) {
    registry.upsert({
      ...historical,
      messages: current.messages.map((message) => ({ ...message, streaming: false })),
    });
    return;
  }
  if (current.sessionPath) {
    registry.upsert({
      ...current,
      source: "history",
      status: "history",
      connected: false,
      contextPercent: null,
      capabilities: ["resume"],
      messages: current.messages.map((message) => ({ ...message, streaming: false })),
    });
    return;
  }
  registry.update(sessionId, { connected: false, status: "disconnected" });
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  if (environment.OMP_REMOTE_ORIGIN) return origin === environment.OMP_REMOTE_ORIGIN;
  try {
    const hostname = new URL(origin).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname.endsWith(".ts.net")
    );
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
