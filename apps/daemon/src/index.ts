import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { createLogger } from "@omp-remote/observability";
import { type RpcFrame, RpcSession } from "@omp-remote/omp-rpc";
import {
  BrowserCommandSchema,
  type AskRequest,
  ExtensionFrameSchema,
  SessionCatalogPageSchema,
  SessionTranscriptResponseSchema,
  type ServerFrame,
  type Session,
} from "@omp-remote/protocol";
import { SessionRegistry } from "@omp-remote/sessions/services";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  broadcastBrowserFrame,
  type BrowserFrameDeliveryResult,
  sendBrowserFrame,
} from "./browser-broadcast.js";
import { normalizeRpcAskEvent } from "./rpc-ask.js";
import {
  createCatalogReconciler,
  createReconciledSessionRegistrar,
} from "./catalog-reconciliation.js";
import { resolveGitBranch } from "./git-branch.js";
import { normalizeRawMessage, normalizeSkillCommands } from "./message-normalizer.js";
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
const RpcMessagesResponseSchema = z.object({
  type: z.literal("response"),
  command: z.literal("get_messages"),
  success: z.literal(true),
  data: z.union([z.array(z.unknown()), z.object({ messages: z.array(z.unknown()) })]),
});
const RpcAvailableCommandsResponseSchema = z.object({
  type: z.literal("response"),
  command: z.literal("get_available_commands"),
  success: z.literal(true),
  data: z.object({ commands: z.array(z.unknown()) }),
});
const RpcAvailableCommandsUpdateSchema = z.object({
  type: z.literal("available_commands_update"),
  commands: z.array(z.unknown()),
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
const pendingAskBySession = new Map<string, { request: AskRequest; timeout: NodeJS.Timeout | undefined }>();
const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
const requestCatalogReconciliation = createCatalogReconciler({
  refresh: () => sessionCatalog.refresh(),
  syncActiveSubagents,
  onError: (error) => logger.error("Could not refresh OMP session history", error),
});
const registerExtensionSession = createReconciledSessionRegistrar({
  registerSession: (session) => registry.upsert(session),
  requestCatalogReconciliation,
});

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
  sendToBrowser(socket, {
    type: "snapshot",
    sessions: registry.list(),
    askRequests: [...pendingAskBySession.values()].map(({ request: askRequest }) => askRequest),
  });
  socket.on("message", async (raw) => {
    const command = (() => {
      try {
        return BrowserCommandSchema.parse(JSON.parse(raw.toString()));
      } catch (error) {
        logger.error("Rejected dashboard command", error);
        sendToBrowser(socket, { type: "error", message: "The dashboard command was not valid." });
        return null;
      }
    })();
    if (!command) return;

    if (command.type === "launch") {
      try {
        await launchRpcSession(command.cwd, command.resume);
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          ok: true,
          error: null,
        });
      } catch (error) {
        logger.error("Failed to launch OMP RPC session", error, { cwd: command.cwd });
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "OMP could not start",
        });
      }
      return;
    }
    if (command.type === "ask_response") {
      const pending = pendingAskBySession.get(command.sessionId);
      const rpcSession = rpcSessions.get(command.sessionId);
      const selectedValue = "value" in command.response ? command.response.value : undefined;
      if (
        !pending ||
        pending.request.requestId !== command.askRequestId ||
        !rpcSession ||
        (pending.request.kind === "select" &&
          selectedValue !== undefined &&
          !pending.request.options.includes(selectedValue))
      ) {
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          ok: false,
          error: "This question is no longer waiting for an answer.",
        });
        return;
      }
      try {
        await rpcSession.respondToUiRequest(command.askRequestId, command.response);
        clearPendingAsk(command.sessionId, command.askRequestId);
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          ok: true,
          error: null,
        });
      } catch (error) {
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "OMP rejected the answer",
        });
      }
      return;
    }

    const rpcSession = rpcSessions.get(command.sessionId);
    if (rpcSession) {
      try {
        if (command.command === "kill") {
          await rpcSession.terminate();
        } else if (command.command === "abort") {
          await rpcSession.request({ type: "abort" });
        } else {
          const rpcCommand: RpcFrame =
            command.command === "follow_up"
              ? { type: "follow_up", message: command.text }
              : { type: command.command, message: command.text };
          await rpcSession.request(rpcCommand);
        }
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          ok: true,
          error: null,
        });
      } catch (error) {
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "OMP rejected the command",
        });
      }
      return;
    }

    if (command.command === "kill") {
      sendToBrowser(socket, {
        type: "command_result",
        requestId: command.requestId,
        ok: false,
        error: "Only dashboard-launched sessions can be killed.",
      });
      return;
    }

    const extensionSocket = extensionSockets.get(command.sessionId);
    if (extensionSocket?.readyState === WebSocket.OPEN) {
      extensionSocket.send(JSON.stringify(command));
      return;
    }
    sendToBrowser(socket, {
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
      const catalogSession = sessionCatalog.get(frame.session.id);
      const previousSessionId = extensionSessionBySocket.get(socket);
      if (previousSessionId && previousSessionId !== frame.session.id) {
        extensionSockets.delete(previousSessionId);
        markSessionHistorical(previousSessionId);
      }
      extensionSessionBySocket.set(socket, frame.session.id);
      extensionSockets.set(frame.session.id, socket);
      ignoreCatalogReconciliationFailure(
        registerExtensionSession({
          ...frame.session,
          createdAt: catalogSession?.createdAt ?? frame.session.createdAt ?? frame.session.lastActivity,
          activeSubagents: catalogSession?.activeSubagents ?? [],
        }),
      );
      refreshSessionBranch(frame.session.id, frame.session.cwd);
    } else if (frame.type === "heartbeat") {
      const currentSession = registry.get(frame.sessionId);
      registry.update(frame.sessionId, {
        connected: true,
        status: frame.idle ? "idle" : "running",
        name: frame.name,
        model: frame.model,
        contextPercent: frame.contextPercent,
        lastActivity: new Date().toISOString(),
        ...(frame.skillCommands !== undefined ? { skillCommands: frame.skillCommands } : {}),
      });
      if (currentSession) refreshSessionBranch(frame.sessionId, currentSession.cwd);
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
  ignoreCatalogReconciliationFailure(requestCatalogReconciliation());
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
    const askEvent = normalizeRpcAskEvent(sessionId, frame);
    if (askEvent?.type === "request") {
      setPendingAsk(askEvent.request);
      return;
    }
    if (askEvent?.type === "cancel") {
      clearPendingAsk(sessionId, askEvent.requestId);
      return;
    }
    if (frame.type === "agent_start") {
      registry.update(sessionId, { status: "running", lastActivity: new Date().toISOString() });
    } else if (frame.type === "agent_end") {
      registry.update(sessionId, { status: "idle", lastActivity: new Date().toISOString() });
      void refreshRpcState(sessionId, rpc);
    } else if (frame.type === "available_commands_update") {
      const update = RpcAvailableCommandsUpdateSchema.safeParse(frame);
      if (update.success) {
        registry.update(sessionId, { skillCommands: normalizeSkillCommands(update.data.commands) });
      }
    } else if (frame.type === "process_exit") {
      markSessionHistorical(sessionId);
      rpcSessions.delete(sessionId);
      clearPendingAsk(sessionId);
    } else {
      const parsed = RpcMessageFrameSchema.safeParse(frame);
      if (!parsed.success) return;
      if (parsed.data.type === "message_start") {
        activeMessageId = `rpc-message-${sessionId}-${++messageSequence}`;
      }
      const message = normalizeRawMessage(
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
  const catalogSession = sessionCatalog.get(sessionId);
  const skillCommands = await loadRpcSkillCommands(sessionId, rpc);
  const now = new Date().toISOString();
  const session: Session = {
    id: sessionId,
    source: "rpc",
    name: stateResponse.data.sessionName ?? null,
    cwd,
    branch: await resolveGitBranch(cwd),
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
    createdAt: catalogSession?.createdAt ?? now,
    lastActivity: now,
    capabilities: ["prompt", "steer", "follow_up", "abort", "kill", "resume"],
    messages: [],
    sessionPath: stateResponse.data.sessionFile ?? null,
    activeSubagents: catalogSession?.activeSubagents ?? [],
    skillCommands,
  };
  rpcSessions.set(sessionId, rpc);
  registry.upsert(session);

  try {
    const messagesResponse = RpcMessagesResponseSchema.parse(await rpc.request({ type: "get_messages" }));
    const messages = Array.isArray(messagesResponse.data)
      ? messagesResponse.data
      : messagesResponse.data.messages;
    for (const [index, rawMessage] of messages.slice(-MAX_MESSAGES).entries()) {
      const message = normalizeRawMessage(rawMessage, false, `rpc-history-${sessionId}-${index}`);
      if (message) registry.appendMessage(sessionId, message);
    }
  } catch (error) {
    logger.error("Could not load initial OMP transcript", error, { sessionId });
  }
  return registry.get(sessionId) ?? session;
}

async function loadRpcSkillCommands(sessionId: string, rpc: RpcSession): Promise<Session["skillCommands"]> {
  try {
    const response = RpcAvailableCommandsResponseSchema.parse(
      await rpc.request({ type: "get_available_commands" }),
    );
    return normalizeSkillCommands(response.data.commands);
  } catch (error) {
    logger.error("Could not load OMP skill commands", error, { sessionId });
    return [];
  }
}

async function refreshRpcState(sessionId: string, rpc: RpcSession): Promise<void> {
  try {
    const currentSession = registry.get(sessionId);
    const response = RpcStateResponseSchema.parse(await rpc.request({ type: "get_state" }));
    registry.update(sessionId, {
      name: response.data.sessionName ?? null,
      model: response.data.model ? `${response.data.model.provider}/${response.data.model.id}` : null,
      contextPercent: normalizePercent(response.data.contextUsage?.percent),
      ...(currentSession ? { branch: await resolveGitBranch(currentSession.cwd) } : {}),
      status: response.data.queuedMessageCount ? "waiting" : response.data.isStreaming ? "running" : "idle",
    });
  } catch (error) {
    logger.error("Could not refresh OMP RPC state", error, { sessionId });
  }
}
function ignoreCatalogReconciliationFailure(reconciliation: Promise<void>): void {
  void reconciliation.catch((error) => {
    try {
      logger.error("Catalog reconciliation failed unexpectedly", error);
    } catch {
      // A logging failure cannot be allowed to create another unhandled rejection.
    }
  });
}

function refreshSessionBranch(sessionId: string, cwd: string): void {
  void resolveGitBranch(cwd).then((branch) => {
    const currentSession = registry.get(sessionId);
    if (currentSession?.cwd === cwd) registry.update(sessionId, { branch });
  });
}

function syncActiveSubagents(catalogSession: Session): void {
  const liveSession = registry.get(catalogSession.id);
  if (
    !liveSession ||
    (liveSession.createdAt === catalogSession.createdAt &&
      activeSubagentsEqual(liveSession.activeSubagents, catalogSession.activeSubagents))
  )
    return;
  registry.update(catalogSession.id, {
    createdAt: catalogSession.createdAt,
    activeSubagents: catalogSession.activeSubagents,
  });
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

function sendToBrowser(socket: WebSocket, frame: ServerFrame): void {
  reportBrowserBackpressure(sendBrowserFrame(socket, frame));
}

function broadcast(frame: ServerFrame): void {
  reportBrowserBackpressure(broadcastBrowserFrame(browserSockets, frame));
}

function setPendingAsk(request: AskRequest): void {
  clearPendingAsk(request.sessionId);
  let timeout: NodeJS.Timeout | undefined;
  if (request.expiresAt) {
    timeout = setTimeout(
      () => clearPendingAsk(request.sessionId, request.requestId),
      Math.max(0, Date.parse(request.expiresAt) - Date.now()),
    );
    timeout.unref();
  }
  pendingAskBySession.set(request.sessionId, { request, timeout });
  broadcast({ type: "ask_request", request });
}

function clearPendingAsk(sessionId: string, requestId?: string): void {
  const pending = pendingAskBySession.get(sessionId);
  if (!pending || (requestId !== undefined && pending.request.requestId !== requestId)) return;
  clearTimeout(pending.timeout);
  pendingAskBySession.delete(sessionId);
  broadcast({
    type: "ask_cancelled",
    sessionId,
    requestId: pending.request.requestId,
  });
}

function reportBrowserBackpressure(result: BrowserFrameDeliveryResult): void {
  if (result.terminated === 0) return;
  logger.warn("Terminated lagging dashboard WebSocket peers", {
    terminatedPeers: result.terminated,
    maxRejectedBufferedBytes: result.maxRejectedBufferedBytes,
  });
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
