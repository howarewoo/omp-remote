import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { createLogger } from "@omp-remote/observability";
import { type RpcFrame, RpcSession } from "@omp-remote/omp-rpc";
import {
  type AskRequest,
  type AskResponse,
  type BrowserCommand,
  BrowserCommandSchema,
  EffortSchema,
  ExtensionFrameSchema,
  type ServerFrame,
  type Session,
  type SessionBranchTopology,
  SessionBranchTopologySchema,
  SessionCatalogPageSchema,
  SessionCostResponseSchema,
  SessionFileChangesResponseSchema,
  type SessionModelOption,
  SessionTranscriptResponseSchema,
  type TranscriptMessage,
  validateTranscriptImageBytes,
} from "@omp-remote/protocol";
import { SessionRegistry } from "@omp-remote/sessions/services";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  type BrowserFrameDeliveryResult,
  broadcastBrowserFrame,
  sendBrowserFrame,
} from "./browser-broadcast.js";
import {
  createCatalogReconciler,
  createReconciledSessionRegistrar,
  getCatalogSessionMetadataPatch,
} from "./catalog-reconciliation.js";
import {
  assertBranchSwitchSessionState,
  loadGitBranchTopology,
  resolveGitBranch,
  resolveGitWorktree,
  switchGitBranch,
} from "./git-branch.js";
import {
  materializeReadImages,
  normalizeRawMessage,
  normalizeSkillCommands,
  ToolCallTracker,
} from "./message-normalizer.js";
import {
  type AskInactivityTimeout,
  clearAskInactivityTimeout,
  createAskInactivityTimeout,
  expireExtensionAsk,
  isAskResponseValid,
  normalizeRpcAskEvent,
  ownsCurrentExtensionSocket,
  releaseCurrentExtensionSocket,
  resetAskInactivityTimeout,
} from "./rpc-ask.js";
import { SavedWorkingDirectoryStore } from "./saved-working-directories.js";
import {
  createReadImageResolver,
  resolveAgentBlobDirectory,
  resolveSessionRoots,
  SessionCatalog,
} from "./session-catalog.js";
import { collectSessionFileChanges } from "./session-file-changes.js";

function sanitizeTranscriptMessageImages(message: TranscriptMessage): TranscriptMessage {
  if (!message.images?.length) return message;
  return {
    ...message,
    images: message.images.map((image) => {
      if (image.status !== "available") return image;
      const bytes = Buffer.from(image.data, "base64");
      return validateTranscriptImageBytes(bytes, image.mimeType)
        ? { status: "unavailable" as const, reason: "mime_mismatch" as const }
        : image;
    }),
  };
}

function sanitizeExtensionSession<T extends { messages: TranscriptMessage[] }>(
  session: T,
): Omit<T, "messages"> & { messages: TranscriptMessage[] } {
  return {
    ...session,
    messages: session.messages.map(sanitizeTranscriptMessageImages),
  };
}

const MAX_MESSAGES = 200;
const BRANCH_SWITCH_STATE_TIMEOUT_MS = 2_000;
const MAX_CONCURRENT_BRANCH_TOPOLOGY_LOADS = 4;
const MAX_CONCURRENT_WORKTREE_RESOLUTIONS = 8;
const logger = createLogger("omp-remote-daemon");
const EnvironmentSchema = z.object({
  OMP_REMOTE_HOST: z.enum(["127.0.0.1", "::1", "localhost"]).default("127.0.0.1"),
  OMP_REMOTE_PORT: z.coerce.number().int().min(1).max(65_535).default(4387),
  OMP_REMOTE_ORIGIN: z.string().url().optional(),
  OMP_REMOTE_OMP_PATH: z.string().min(1).default("omp"),
});
const RpcModelSchema = z
  .object({
    provider: z.string(),
    id: z.string(),
    name: z.string(),
    thinking: z
      .object({
        efforts: z.array(EffortSchema),
        requiresEffort: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

const RpcStateResponseSchema = z.object({
  type: z.literal("response"),
  command: z.literal("get_state"),
  success: z.literal(true),
  data: z.object({
    sessionId: z.string(),
    sessionName: z.string().nullable().optional(),
    sessionFile: z.string().nullable().optional(),
    model: RpcModelSchema.nullable().optional(),
    thinkingLevel: EffortSchema.optional(),
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
const RpcAvailableModelsResponseSchema = z.object({
  type: z.literal("response"),
  command: z.literal("get_available_models"),
  success: z.literal(true),
  data: z.object({ models: z.array(RpcModelSchema) }),
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
const savedWorkingDirectories = await SavedWorkingDirectoryStore.load();
const sessionCatalog = new SessionCatalog(
  await resolveSessionRoots(homedir(), process.env.PI_CODING_AGENT_DIR),
);
const initialCatalogDiff = await sessionCatalog.refresh();
const registry = new SessionRegistry();
sessionCatalog.setDiffListener(({ upserted }) => {
  for (const session of upserted) syncCatalogSession(session);
});
const browserSockets = new Set<WebSocket>();
const rpcSessions = new Map<string, RpcSession>();
const extensionSockets = new Map<string, WebSocket>();
const extensionSessionBySocket = new Map<WebSocket, string>();
const switchingGitWorktrees = new Set<string>();
const branchSwitchingSessionIds = new Set<string>();
const branchTopologyLoads = new Map<string, Promise<SessionBranchTopology | null>>();
let activeBranchTopologyLoads = 0;
const pendingAskBySession = new Map<
  string,
  {
    request: AskRequest;
    source: "rpc" | "extension";
    timeout: AskInactivityTimeout | undefined;
  }
>();

class BranchTopologyCapacityError extends Error {}

async function loadSessionBranchTopology(
  cwd: string,
  sessionId: string,
): Promise<SessionBranchTopology | null> {
  const worktree = await resolveGitWorktree(cwd);
  if (!worktree) return null;
  const pendingLoad = branchTopologyLoads.get(worktree);
  if (pendingLoad) {
    const topology = await pendingLoad;
    return topology ? { ...topology, sessionId } : null;
  }
  if (activeBranchTopologyLoads >= MAX_CONCURRENT_BRANCH_TOPOLOGY_LOADS) {
    throw new BranchTopologyCapacityError("Branch topology capacity is exhausted");
  }

  activeBranchTopologyLoads += 1;
  const load = loadGitBranchTopology(cwd, sessionId);
  branchTopologyLoads.set(worktree, load);
  try {
    const topology = await load;
    return topology ? { ...topology, sessionId } : null;
  } finally {
    if (branchTopologyLoads.get(worktree) === load) branchTopologyLoads.delete(worktree);
    activeBranchTopologyLoads -= 1;
  }
}

const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
const requestCatalogReconciliation = createCatalogReconciler({
  refresh: () => sessionCatalog.refresh(),
  syncCatalogSession,
  onError: (error) => logger.error("Could not refresh OMP session history", error),
});
const registerExtensionSession = createReconciledSessionRegistrar({
  registerSession: (session) => registry.upsert(session),
  requestCatalogReconciliation,
});

await app.register(fastifyWebsocket, { options: { maxPayload: 96 * 1024 * 1024 } });

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

app.get("/api/sessions/:sessionId/cost", async (request, reply) => {
  const params = SessionParamsSchema.safeParse(request.params);
  if (!params.success) return reply.code(404).send({ error: "Session history was not found" });
  if (!sessionCatalog.get(params.data.sessionId)) await requestCatalogReconciliation();
  if (!sessionCatalog.get(params.data.sessionId)) {
    return reply.code(404).send({ error: "Session history was not found" });
  }
  try {
    return SessionCostResponseSchema.parse({
      sessionId: params.data.sessionId,
      costSummary: (await sessionCatalog.costSummary(params.data.sessionId)) ?? null,
    });
  } catch (error) {
    logger.error("Could not read OMP session cost", error, { sessionId: params.data.sessionId });
    return reply.code(500).send({ error: "Session cost could not be read" });
  }
});

app.get("/api/sessions/:sessionId/changes", async (request, reply) => {
  const params = SessionParamsSchema.safeParse(request.params);
  if (!params.success) return reply.code(404).send({ error: "Session history was not found" });
  const selection = sessionCatalog.fileChangeSources(params.data.sessionId);
  if (!selection) return reply.code(404).send({ error: "Session history was not found" });
  try {
    return SessionFileChangesResponseSchema.parse(
      await collectSessionFileChanges({
        sessionId: params.data.sessionId,
        sources: selection.sources,
        truncated: selection.truncated,
      }),
    );
  } catch (error) {
    logger.error("Could not read session file changes", error, { sessionId: params.data.sessionId });
    return reply.code(500).send({ error: "Session file changes could not be read" });
  }
});

app.get("/api/sessions/:sessionId/branches", async (request, reply) => {
  const params = SessionParamsSchema.safeParse(request.params);
  const session = params.success ? registry.get(params.data.sessionId) : undefined;
  if (
    !params.success ||
    !session?.connected ||
    session.source === "history" ||
    session.status === "disconnected" ||
    session.status === "history"
  ) {
    return reply.code(404).send({ error: "Live session was not found" });
  }
  try {
    const topology = await loadSessionBranchTopology(session.cwd, session.id);
    if (!topology) return reply.code(409).send({ error: "Session is not on a local Git branch" });
    const parsedTopology = SessionBranchTopologySchema.safeParse(topology);
    if (!parsedTopology.success) {
      return reply.code(422).send({ error: "Session branch topology exceeds supported limits" });
    }
    return parsedTopology.data;
  } catch (error) {
    if (error instanceof BranchTopologyCapacityError) {
      return reply.code(503).send({ error: "Session branch topology is temporarily unavailable" });
    }
    logger.error("Could not read session branch topology", error, { sessionId: session.id });
    return reply.code(500).send({ error: "Session branch topology could not be read" });
  }
});

app.get("/ws", { websocket: true }, (socket, request) => {
  if (!originAllowed(request.headers.origin, request.headers.host)) {
    socket.close(1008, "Origin is not allowed");
    return;
  }
  browserSockets.add(socket);
  sendToBrowser(socket, {
    type: "snapshot",
    sessions: registry.list(),
    askRequests: [...pendingAskBySession.values()].map(({ request: askRequest }) => askRequest),
    savedWorkingDirectories: savedWorkingDirectories.list(),
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

    if (command.type === "save_working_directory" || command.type === "remove_working_directory") {
      try {
        const directories =
          command.type === "save_working_directory"
            ? await savedWorkingDirectories.save(command.cwd)
            : await savedWorkingDirectories.remove(command.cwd);
        broadcast({
          type: "saved_working_directories",
          savedWorkingDirectories: directories,
        });
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          outcome: { status: "ok", value: { type: "void" } },
        });
      } catch (error) {
        logger.error("Could not update saved working directories", error, {
          cwd: command.cwd,
          operation: command.type,
        });
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : "Saved working directories could not be updated",
          },
        });
      }
      return;
    }

    if (command.type === "launch") {
      try {
        const session = await launchRpcSession(command.cwd, command.resume);
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          outcome: { status: "ok", value: { type: "launch", sessionId: session.id } },
        });
      } catch (error) {
        logger.error("Failed to launch OMP RPC session", error, { cwd: command.cwd });
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : "OMP could not start",
          },
        });
      }
      return;
    }
    if (command.type === "ask_activity") {
      const pending = pendingAskBySession.get(command.sessionId);
      if (pending) {
        resetAskInactivityTimeout(pending.timeout, command.sessionId, command.askRequestId, () =>
          expirePendingAsk(command.sessionId, command.askRequestId, pending.source),
        );
      }
      return;
    }

    if (command.type === "ask_response") {
      const pending = pendingAskBySession.get(command.sessionId);
      if (
        !pending ||
        pending.request.requestId !== command.askRequestId ||
        !isAskResponseValid(pending.request, command.response)
      ) {
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          outcome: {
            status: "error",
            error: "This question is no longer waiting for an answer.",
          },
        });
        return;
      }
      try {
        if (pending.source === "rpc") {
          const rpcSession = rpcSessions.get(command.sessionId);
          if (pending.request.kind === "rich" || "kind" in command.response) {
            throw new Error("The RPC ask response did not match its request.");
          }
          if (!rpcSession) throw new Error("This OMP session is no longer connected.");
          await rpcSession.respondToUiRequest(command.askRequestId, command.response);
        } else {
          const extensionSocket = extensionSockets.get(command.sessionId);
          if (extensionSocket?.readyState !== WebSocket.OPEN) {
            throw new Error("This OMP session is no longer connected.");
          }
          extensionSocket.send(
            JSON.stringify({
              command: "ask_response",
              requestId: command.askRequestId,
              response: command.response,
            }),
          );
        }
        clearPendingAsk(command.sessionId, command.askRequestId);
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          outcome: { status: "ok", value: { type: "void" } },
        });
      } catch (error) {
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : "OMP rejected the answer",
          },
        });
      }
      return;
    }

    if (command.type === "switch_branch") {
      const startedAt = Date.now();
      try {
        await switchSessionBranch(command);
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          outcome: { status: "ok", value: { type: "void" } },
        });
      } catch (error) {
        logger.error("Could not switch Git branch", error, {
          sessionId: command.sessionId,
          branch: command.branch,
          stage: "switch_branch",
          elapsedMs: Date.now() - startedAt,
        });
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : "OMP rejected the branch switch",
          },
        });
      }
      return;
    }
    if (await branchSwitchBlocksSessionCommand(command)) {
      sendToBrowser(socket, {
        type: "command_result",
        requestId: command.requestId,
        outcome: {
          status: "error",
          error: "Cannot run a prompt while the session is switching branches.",
        },
      });
      return;
    }

    const rpcSession = rpcSessions.get(command.sessionId);
    if (rpcSession) {
      try {
        if (command.command === "kill") {
          await rpcSession.terminate();
        } else if (command.command === "abort") {
          await rpcSession.request({ type: "abort" });
        } else if (command.command === "set_model") {
          const [provider, ...modelId] = command.model.split("/");
          await rpcSession.request({ type: "set_model", provider, modelId: modelId.join("/") });
          await refreshRpcState(command.sessionId, rpcSession);
        } else if (command.command === "set_effort") {
          await rpcSession.request({ type: "set_thinking_level", level: command.effort });
          await refreshRpcState(command.sessionId, rpcSession);
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
          outcome: { status: "ok", value: { type: "void" } },
        });
      } catch (error) {
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : "OMP rejected the command",
          },
        });
      }
      return;
    }

    if (command.command === "kill") {
      sendToBrowser(socket, {
        type: "command_result",
        requestId: command.requestId,
        outcome: { status: "error", error: "Only dashboard-launched sessions can be killed." },
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
      outcome: { status: "error", error: "This OMP session is no longer connected." },
    });
  });
  socket.on("close", () => {
    browserSockets.delete(socket);
    if (browserSockets.size > 0) return;
    for (const [sessionId, pending] of pendingAskBySession) {
      if (pending.source !== "extension") continue;
      sendExtensionAskUnavailable(sessionId, pending.request.requestId);
      clearPendingAsk(sessionId, pending.request.requestId);
    }
  });
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
        const releasedSessionId = releaseCurrentExtensionSocket(
          socket,
          extensionSessionBySocket,
          extensionSockets,
        );
        if (releasedSessionId) {
          clearPendingAsk(releasedSessionId);
          markSessionHistorical(releasedSessionId);
        }
      }
      const replacedSocket = extensionSockets.get(frame.session.id);
      if (replacedSocket && replacedSocket !== socket) {
        const pending = pendingAskBySession.get(frame.session.id);
        if (pending?.source === "extension") {
          sendExtensionAskUnavailable(frame.session.id, pending.request.requestId);
          clearPendingAsk(frame.session.id, pending.request.requestId);
        }
      }
      extensionSessionBySocket.set(socket, frame.session.id);
      extensionSockets.set(frame.session.id, socket);
      ignoreCatalogReconciliationFailure(
        registerExtensionSession({
          ...sanitizeExtensionSession(frame.session),
          createdAt: catalogSession?.createdAt ?? frame.session.createdAt ?? frame.session.lastActivity,
          activeSubagents: catalogSession?.activeSubagents ?? [],
        }),
      );
      refreshSessionBranch(frame.session.id, frame.session.cwd);
    } else if (frame.type === "ask_request") {
      if (
        !ownsCurrentExtensionSocket(
          socket,
          frame.request.sessionId,
          extensionSessionBySocket,
          extensionSockets,
        ) ||
        frame.request.kind !== "rich" ||
        browserSockets.size === 0
      ) {
        socket.send(
          JSON.stringify({
            command: "ask_unavailable",
            requestId: frame.request.requestId,
          }),
        );
        return;
      }
      setPendingAsk(frame.request, "extension");
      socket.send(JSON.stringify({ command: "ask_admitted", requestId: frame.request.requestId }));
    } else if (frame.type === "ask_activity") {
      if (ownsCurrentExtensionSocket(socket, frame.sessionId, extensionSessionBySocket, extensionSockets)) {
        const pending = pendingAskBySession.get(frame.sessionId);
        if (pending?.source === "extension") {
          resetAskInactivityTimeout(pending.timeout, frame.sessionId, frame.requestId, () =>
            expirePendingAsk(frame.sessionId, frame.requestId, "extension"),
          );
        }
      }
    } else if (frame.type === "ask_cancelled") {
      if (ownsCurrentExtensionSocket(socket, frame.sessionId, extensionSessionBySocket, extensionSockets)) {
        clearPendingAsk(frame.sessionId, frame.requestId);
      }
    } else if (frame.type === "heartbeat") {
      const currentSession = registry.get(frame.sessionId);
      registry.update(frame.sessionId, {
        connected: true,
        status: frame.idle ? "idle" : "running",
        name: frame.name,
        model: frame.model,
        contextPercent: frame.contextPercent,
        effort: frame.effort,
        availableModels: frame.availableModels,
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
        effort: frame.effort,
        lastActivity: new Date().toISOString(),
      });
      if (frame.message) {
        registry.appendMessage(frame.sessionId, sanitizeTranscriptMessageImages(frame.message));
      }
    } else {
      broadcast({
        type: "command_result",
        requestId: frame.requestId,
        outcome: frame.ok
          ? { status: "ok", value: { type: "void" } }
          : { status: "error", error: frame.error },
      });
    }
  });
  socket.on("close", () => {
    const sessionId = releaseCurrentExtensionSocket(socket, extensionSessionBySocket, extensionSockets);
    if (!sessionId) return;
    clearPendingAsk(sessionId);
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
  let sessionBlobDirectory: string | undefined;
  let messageSequence = 0;
  let activeMessageId: string | undefined;
  const toolCallTracker = new ToolCallTracker();
  rpc.subscribe((frame) => {
    if (!sessionId) return;
    const askEvent = normalizeRpcAskEvent(sessionId, frame);
    if (askEvent?.type === "request") {
      setPendingAsk(askEvent.request, "rpc");
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
        {
          toolCallTracker,
          ...(sessionBlobDirectory
            ? { resolveReadImage: createReadImageResolver(sessionBlobDirectory) }
            : {}),
        },
      );
      if (message) registry.appendMessage(sessionId, message);
      if (parsed.data.type === "message_end") activeMessageId = undefined;
    }
  });

  const stateResponse = RpcStateResponseSchema.parse(await rpc.start());
  sessionId = stateResponse.data.sessionId;
  if (!sessionId) throw new Error("OMP RPC did not return a session ID");
  sessionBlobDirectory = stateResponse.data.sessionFile
    ? resolveAgentBlobDirectory(stateResponse.data.sessionFile)
    : undefined;
  const contextPercent = normalizePercent(stateResponse.data.contextUsage?.percent);
  const catalogSession = sessionCatalog.get(sessionId);
  const [skillCommands, availableModels] = await Promise.all([
    loadRpcSkillCommands(sessionId, rpc),
    loadRpcModelOptions(sessionId, rpc),
  ]);
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
    effort: stateResponse.data.thinkingLevel ?? null,
    availableModels,
    contextPercent,
    createdAt: catalogSession?.createdAt ?? now,
    lastActivity: now,
    capabilities: ["prompt", "steer", "follow_up", "abort", "kill", "resume", "model", "effort"],
    messages: [],
    sessionPath: stateResponse.data.sessionFile ?? null,
    activeSubagents: catalogSession?.activeSubagents ?? [],
    skillCommands,
  };
  rpcSessions.set(sessionId, rpc);
  registry.upsert(session);
  void requestCatalogReconciliation();

  try {
    const messagesResponse = RpcMessagesResponseSchema.parse(await rpc.request({ type: "get_messages" }));
    const messages = Array.isArray(messagesResponse.data)
      ? messagesResponse.data
      : messagesResponse.data.messages;
    const visibleMessageStart = Math.max(0, messages.length - MAX_MESSAGES);
    const retained: Array<{ raw: unknown; message: TranscriptMessage }> = [];
    for (const [index, rawMessage] of messages.entries()) {
      const message = normalizeRawMessage(
        rawMessage,
        false,
        `rpc-history-${sessionId}-${Math.max(0, index - visibleMessageStart)}`,
        { toolCallTracker },
      );
      if (index >= visibleMessageStart && message) retained.push({ raw: rawMessage, message });
    }
    const resolveImage = sessionBlobDirectory ? createReadImageResolver(sessionBlobDirectory) : undefined;
    for (const { raw, message } of retained) {
      const materialized = resolveImage ? materializeReadImages(message, raw, resolveImage) : message;
      registry.appendMessage(sessionId, materialized);
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

async function loadRpcModelOptions(sessionId: string, rpc: RpcSession): Promise<SessionModelOption[]> {
  try {
    const response = RpcAvailableModelsResponseSchema.parse(
      await rpc.request({ type: "get_available_models" }),
    );
    return response.data.models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      efforts: model.thinking
        ? [...(model.thinking.requiresEffort ? [] : (["off"] as const)), ...model.thinking.efforts]
        : [],
    }));
  } catch (error) {
    logger.error("Could not load OMP model choices", error, { sessionId });
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
      effort: response.data.thinkingLevel ?? null,
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

function sameSessionRegistration(left: Session, right: Session): boolean {
  return (
    left.id === right.id &&
    left.source === right.source &&
    left.cwd === right.cwd &&
    left.createdAt === right.createdAt &&
    left.sessionPath === right.sessionPath
  );
}

function isLiveBranchSession(session: Session): boolean {
  return (
    session.connected &&
    session.source !== "history" &&
    session.status !== "disconnected" &&
    session.status !== "history"
  );
}

async function branchSwitchBlocksSessionCommand(
  command: Extract<BrowserCommand, { type: "session_command" }>,
): Promise<boolean> {
  if (command.command !== "prompt" && command.command !== "steer" && command.command !== "follow_up") {
    return false;
  }
  if (branchSwitchingSessionIds.has(command.sessionId)) return true;
  if (switchingGitWorktrees.size === 0) return false;
  const session = registry.get(command.sessionId);
  if (!session || !isLiveBranchSession(session)) return false;
  const worktree = await resolveGitWorktree(session.cwd);
  return worktree !== null && switchingGitWorktrees.has(worktree);
}

async function sessionsInGitWorktree(expectedSession: Session, worktree: string): Promise<Session[]> {
  const candidates = registry.list().filter(isLiveBranchSession);
  const resolvedWorktrees = new Array<string | null>(candidates.length);
  let nextIndex = 0;
  const workerCount = Math.min(MAX_CONCURRENT_WORKTREE_RESOLUTIONS, candidates.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < candidates.length) {
        const index = nextIndex;
        nextIndex += 1;
        const candidate = candidates[index];
        if (!candidate) continue;
        resolvedWorktrees[index] =
          candidate.cwd === expectedSession.cwd ? worktree : await resolveGitWorktree(candidate.cwd);
      }
    }),
  );
  return candidates.filter((_, index) => resolvedWorktrees[index] === worktree);
}

async function assertSessionIdleForBranchSwitch(session: Session): Promise<void> {
  assertBranchSwitchSessionState(session);
  if (session.source === "rpc") {
    const rpcSession = rpcSessions.get(session.id);
    if (!rpcSession) throw new Error("This OMP session is no longer connected.");
    const state = RpcStateResponseSchema.parse(
      await rpcSession.request({ type: "get_state" }, { timeoutMs: BRANCH_SWITCH_STATE_TIMEOUT_MS }),
    );
    if (state.data.isStreaming || state.data.queuedMessageCount) {
      throw new Error("Cannot switch branches while a session in the Git worktree is running.");
    }
    return;
  }
  if (session.source === "extension") {
    const extensionSocket = extensionSockets.get(session.id);
    if (extensionSocket?.readyState !== WebSocket.OPEN) {
      throw new Error("This OMP session is no longer connected.");
    }
    return;
  }
  throw new Error("Historical sessions cannot switch branches.");
}

async function refreshGitWorktreeSessions(
  expectedSession: Session,
  worktree: string,
  branch: string | null,
): Promise<boolean> {
  let expectedSessionUpdated = false;
  for (const candidate of await sessionsInGitWorktree(expectedSession, worktree)) {
    const current = registry.get(candidate.id);
    if (!current || !sameSessionRegistration(candidate, current)) continue;
    if (candidate.id === expectedSession.id && !sameSessionRegistration(expectedSession, current)) {
      continue;
    }
    if (!registry.update(candidate.id, { branch })) continue;
    if (candidate.id === expectedSession.id) expectedSessionUpdated = true;
  }
  return expectedSessionUpdated;
}

async function switchSessionBranch(
  command: Extract<BrowserCommand, { type: "switch_branch" }>,
): Promise<void> {
  const session = registry.get(command.sessionId);
  if (!session) throw new Error("This OMP session is no longer connected.");
  assertBranchSwitchSessionState(session);

  const worktree = await resolveGitWorktree(session.cwd);
  if (!worktree) throw new Error("Session is not in a Git worktree.");
  if (switchingGitWorktrees.has(worktree)) {
    throw new Error("A branch switch is already in progress for this Git worktree.");
  }
  switchingGitWorktrees.add(worktree);
  const lockedSessionIds = new Set([session.id]);
  branchSwitchingSessionIds.add(session.id);

  try {
    const switchSessions: Session[] = [];
    let refreshedSession: Session | undefined;
    for (const candidate of await sessionsInGitWorktree(session, worktree)) {
      const current = registry.get(candidate.id);
      if (!current || !sameSessionRegistration(candidate, current)) {
        if (candidate.id === session.id) {
          throw new Error("This OMP session is no longer connected.");
        }
        continue;
      }
      if (candidate.id === session.id && !sameSessionRegistration(session, current)) {
        throw new Error("This OMP session is no longer connected.");
      }
      lockedSessionIds.add(current.id);
      branchSwitchingSessionIds.add(current.id);
      switchSessions.push(current);
      if (current.id === session.id) refreshedSession = current;
    }
    if (!refreshedSession) throw new Error("This OMP session is no longer connected.");
    await Promise.all(switchSessions.map(assertSessionIdleForBranchSwitch));

    const checkedSession = registry.get(command.sessionId);
    if (!checkedSession || !sameSessionRegistration(refreshedSession, checkedSession)) {
      throw new Error("This OMP session is no longer connected.");
    }
    assertBranchSwitchSessionState(checkedSession);

    let switchError: unknown;
    try {
      await switchGitBranch(checkedSession.cwd, command.branch);
    } catch (error) {
      switchError = error;
    }
    const branch = await resolveGitBranch(checkedSession.cwd);
    if (!(await refreshGitWorktreeSessions(checkedSession, worktree, branch))) {
      throw new Error("This OMP session is no longer connected.");
    }
    if (switchError) throw switchError;
    if (branch !== command.branch) throw new Error("Git did not switch to the requested branch.");
  } finally {
    for (const sessionId of lockedSessionIds) branchSwitchingSessionIds.delete(sessionId);
    switchingGitWorktrees.delete(worktree);
  }
}

function syncCatalogSession(catalogSession: Session): void {
  const liveSession = registry.get(catalogSession.id);
  if (!liveSession) return;

  const patch = getCatalogSessionMetadataPatch(liveSession, catalogSession);
  if (!patch) return;
  registry.update(catalogSession.id, patch);
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

function setPendingAsk(request: AskRequest, source: "rpc" | "extension"): void {
  const previous = pendingAskBySession.get(request.sessionId);
  if (previous?.source === "extension") {
    sendExtensionAskUnavailable(request.sessionId, previous.request.requestId);
  }
  clearPendingAsk(request.sessionId);
  const timeout = createAskInactivityTimeout(request.sessionId, request.requestId, request.expiresAt, () =>
    expirePendingAsk(request.sessionId, request.requestId, source),
  );
  pendingAskBySession.set(request.sessionId, { request, source, timeout });
  broadcast({ type: "ask_request", request });
}

function clearPendingAsk(sessionId: string, requestId?: string): void {
  const pending = pendingAskBySession.get(sessionId);
  if (!pending || (requestId !== undefined && pending.request.requestId !== requestId)) return;
  clearAskInactivityTimeout(pending.timeout);
  pendingAskBySession.delete(sessionId);
  broadcast({
    type: "ask_cancelled",
    sessionId,
    requestId: pending.request.requestId,
  });
}

function expirePendingAsk(sessionId: string, requestId: string, source: "rpc" | "extension"): void {
  const pending = pendingAskBySession.get(sessionId);
  if (!pending || pending.request.requestId !== requestId || pending.source !== source) return;
  if (source === "extension") {
    expireExtensionAsk(sessionId, requestId, sendExtensionAskResponse, clearPendingAsk);
  } else {
    clearPendingAsk(sessionId, requestId);
  }
}

function sendExtensionAskResponse(sessionId: string, requestId: string, response: AskResponse): void {
  const socket = extensionSockets.get(sessionId);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        command: "ask_response",
        requestId,
        response,
      }),
    );
  }
}

function sendExtensionAskUnavailable(sessionId: string, requestId: string): void {
  const socket = extensionSockets.get(sessionId);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ command: "ask_unavailable", requestId }));
  }
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

function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  if (environment.OMP_REMOTE_ORIGIN) return origin === environment.OMP_REMOTE_ORIGIN;
  try {
    const originUrl = new URL(origin);
    const { hostname } = originUrl;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
    return (
      originUrl.protocol === "https:" &&
      hostname.endsWith(".ts.net") &&
      originUrl.host === host?.toLowerCase()
    );
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
