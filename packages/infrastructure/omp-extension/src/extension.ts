import { createHash } from "node:crypto";
import { closeSync, existsSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionAskDialogQuestion,
  ExtensionAskDialogResult,
  ExtensionContext,
  ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent";
import {
  type AskRequest,
  type AskResponse,
  type ExtensionCommand,
  getTranscriptImageByteLength,
  normalizeSkillPromptRecord,
  TRANSCRIPT_IMAGE_MAX_BYTES,
  TRANSCRIPT_IMAGE_SESSION_MAX_BYTES,
  type TranscriptImage,
  type TranscriptImageMimeType,
  type TranscriptMessage,
  validateTranscriptImageBytes,
} from "@omp-remote/protocol";
import { getConfiguredRoleEffort, getSessionModelOptions, getSkillCommands } from "./model-options.js";
import { normalizeRemoteAskResponse, type RemoteAskOutcome } from "./remote-ask.js";
import {
  boundExtensionTranscriptMessages,
  ExtensionToolCallTracker,
  normalizeExtensionMessage,
} from "./transcript-normalizer.js";

export { getConfiguredRoleEffort, getSessionModelOptions, getSkillCommands } from "./model-options.js";
export { normalizeRemoteAskResponse } from "./remote-ask.js";
export {
  boundExtensionTranscriptMessages,
  ExtensionToolCallTracker,
  materializeExtensionReadImages,
  normalizeExtensionMessage,
} from "./transcript-normalizer.js";

const DEFAULT_EXTENSION_URL = "ws://127.0.0.1:4387/extension";
const RECONNECT_DELAY_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

type ExtensionTranscriptMessage = TranscriptMessage;

type ExtensionThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

export function isRpcMode(argv: readonly string[] = process.argv): boolean {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    if (argument === "--mode") return argv[index + 1] === "rpc" || argv[index + 1] === "rpc-ui";
    if (argument?.startsWith("--mode=")) {
      const mode = argument.slice("--mode=".length);
      return mode === "rpc" || mode === "rpc-ui";
    }
  }

  return false;
}

function resolveOwnReadImage(
  reference: string,
  mimeType: string,
  maxBytes = TRANSCRIPT_IMAGE_MAX_BYTES,
): TranscriptImage {
  const match = /^blob:sha256:([a-f0-9]{64})$/.exec(reference);
  const hash = match?.[1];
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
  if (!hash) return { status: "unavailable", reason: "invalid_reference" };
  let handle: number | undefined;
  try {
    const blobPath = join(agentDirectory, "blobs", hash);
    handle = openSync(blobPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fileStats = fstatSync(handle);
    if (!fileStats.isFile()) return { status: "unavailable", reason: "invalid_reference" };
    if (fileStats.size > TRANSCRIPT_IMAGE_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    if (fileStats.size > maxBytes) return { status: "unavailable", reason: "budget_exceeded" };
    const buffer = Buffer.allocUnsafe(Math.min(TRANSCRIPT_IMAGE_MAX_BYTES, maxBytes) + 1);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    if (bytesRead > TRANSCRIPT_IMAGE_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    if (bytesRead > maxBytes) return { status: "unavailable", reason: "budget_exceeded" };
    const bytes = buffer.subarray(0, bytesRead);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
      return { status: "unavailable", reason: "invalid_reference" };
    }
    const reason = validateTranscriptImageBytes(bytes, mimeType);
    if (reason) return { status: "unavailable", reason };
    return {
      status: "available",
      mimeType: mimeType as TranscriptImageMimeType,
      data: bytes.toString("base64"),
    };
  } catch {
    return { status: "unavailable", reason: "missing" };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function createOwnReadImageResolver(maxBytes: number) {
  let remainingBytes = maxBytes;
  return (reference: string, mimeType: string): TranscriptImage => {
    if (remainingBytes <= 0) return { status: "unavailable", reason: "budget_exceeded" };
    const image = resolveOwnReadImage(reference, mimeType, remainingBytes);
    if (image.status === "available") remainingBytes -= getTranscriptImageByteLength(image);
    return image;
  };
}

export default function ompRemoteExtension(pi: ExtensionAPI): void {
  const rpcMode = isRpcMode();
  const { z } = pi.zod;
  const resolveRoleAssignment = (ctx: ExtensionContext, role: string) => {
    if (typeof ctx.models.resolve !== "function") return undefined;
    const model = ctx.models.resolve(role.startsWith("@") ? role : `@${role}`);
    if (!model) return undefined;
    return {
      provider: model.provider,
      id: model.id,
      effort: getConfiguredRoleEffort(role, (candidate) => pi.pi.settings.getModelRole(candidate)),
    };
  };
  const AskDialogResultItemSchema = z
    .object({
      id: z.string().min(1),
      question: z.string(),
      options: z.array(z.string()),
      multi: z.boolean(),
      selectedOptions: z.array(z.string()),
      customInput: z.string().optional(),
      note: z.string().optional(),
      timedOut: z.boolean().optional(),
    })
    .strict();
  const AskResponseSchema = z.union([
    z.object({ value: z.string() }).strict(),
    z.object({ kind: z.literal("submit"), results: z.array(AskDialogResultItemSchema) }).strict(),
    z.object({ kind: z.literal("chat") }).strict(),
    z.object({ cancelled: z.literal(true), timedOut: z.boolean().optional() }).strict(),
  ]);
  const CommandSchema = z.union([
    z.object({
      requestId: z.string(),
      command: z.enum(["prompt", "steer", "follow_up"]),
      text: z.string().min(1),
    }),
    z.object({ requestId: z.string(), command: z.literal("abort") }),
    z.object({
      requestId: z.string(),
      command: z.literal("set_model"),
      model: z.string().regex(/^[^/]+\/.+$/),
    }),
    z.object({
      requestId: z.string(),
      command: z.literal("set_effort"),
      effort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    }),
    z.object({ requestId: z.string().min(1), command: z.literal("ask_admitted") }),
    z.object({
      requestId: z.string().min(1),
      command: z.literal("ask_response"),
      response: AskResponseSchema,
    }),
    z.object({ requestId: z.string().min(1), command: z.literal("ask_unavailable") }),
  ]);
  const SessionEntrySchema = z.object({ id: z.string().optional(), type: z.string() }).passthrough();
  const sessionCreatedAt = new Map<string, string>();
  type AskRelay = {
    context: ExtensionContext;
    nativeAskDialog: NonNullable<ExtensionContext["ui"]["askDialog"]>;
    relayAskDialog: NonNullable<ExtensionContext["ui"]["askDialog"]>;
  };
  type PendingRemoteAsk = {
    sessionId: string;
    request: AskRequest;
    relay: AskRelay;
    publishedSocket?: WebSocket;
    admitted: boolean;
    settled: boolean;
    admit(): void;
    settle(outcome: RemoteAskOutcome): void;
    unsubscribeTerminalInput?: () => void;
  };
  const pendingRemoteAsks = new Map<string, PendingRemoteAsk>();
  let askRelay: AskRelay | undefined;

  let context: ExtensionContext | undefined;
  let socket: WebSocket | undefined;
  let metadataContext: ExtensionContext | undefined;
  let metadataSocket: WebSocket | undefined;
  let metadataActive = false;
  let active = false;
  let activeMessageId: string | undefined;
  let messageSequence = 0;
  const liveToolCallTracker = new ExtensionToolCallTracker();
  let producerReadImageResolver: (data: string, mimeType: string) => TranscriptImage = resolveOwnReadImage;
  const retainedMessagesBySession = new Map<string, Map<string, ExtensionTranscriptMessage>>();
  const firstPromptIdBySession = new Map<string, string>();

  const boundLiveMessage = (
    sessionId: string,
    message: ExtensionTranscriptMessage,
  ): ExtensionTranscriptMessage => {
    const retained =
      retainedMessagesBySession.get(sessionId) ?? new Map<string, ExtensionTranscriptMessage>();
    retained.set(message.id, message);
    while (retained.size > 200) {
      const promptId = firstPromptIdBySession.get(sessionId);
      const oldestId = retained.keys().next().value;
      if (oldestId === undefined) break;
      if (oldestId === promptId) {
        const nextId = retained.keys().next().value;
        if (nextId === undefined) break;
        retained.delete(nextId);
      } else {
        retained.delete(oldestId);
      }
    }
    const bounded = boundExtensionTranscriptMessages([...retained.values()]);
    retained.clear();
    for (const retainedMessage of bounded) retained.set(retainedMessage.id, retainedMessage);
    retainedMessagesBySession.set(sessionId, retained);
    return retained.get(message.id) ?? message;
  };

  const normalizeContextPercent = (ctx: ExtensionContext): number | null => {
    const percent = ctx.getContextUsage()?.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
    return Math.max(0, Math.min(100, percent <= 1 ? percent * 100 : percent));
  };

  const normalizeMessage = (
    raw: unknown,
    streaming: boolean,
    fallbackId?: string,
    toolCallTracker = liveToolCallTracker,
  ) =>
    normalizeExtensionMessage(
      raw,
      streaming,
      fallbackId ?? (() => `extension-message-${++messageSequence}`),
      toolCallTracker,
      producerReadImageResolver,
    );

  const send = (frame: object): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const publishRemoteAsk = (pending: PendingRemoteAsk): void => {
    const currentSocket = socket;
    if (
      !currentSocket ||
      currentSocket.readyState !== WebSocket.OPEN ||
      pending.settled ||
      pending.publishedSocket === currentSocket
    ) {
      return;
    }
    pending.admitted = false;
    pending.publishedSocket = currentSocket;
    currentSocket.send(JSON.stringify({ type: "ask_request", request: pending.request }));
  };

  const disconnectRemoteAsks = (disconnectedSocket: WebSocket): void => {
    for (const pending of pendingRemoteAsks.values()) {
      if (pending.publishedSocket !== disconnectedSocket) continue;
      pending.admitted = false;
    }
  };

  const cleanupRemoteAsk = (requestId: string): PendingRemoteAsk | undefined => {
    const pending = pendingRemoteAsks.get(requestId);
    if (!pending) return undefined;
    pendingRemoteAsks.delete(requestId);
    pending.unsubscribeTerminalInput?.();
    delete pending.unsubscribeTerminalInput;
    return pending;
  };

  const cancelRemoteAsk = (requestId: string): void => {
    const pending = cleanupRemoteAsk(requestId);
    if (!pending) return;
    send({ type: "ask_cancelled", sessionId: pending.sessionId, requestId });
  };

  const loseRemoteAsks = (): void => {
    for (const [requestId, pending] of pendingRemoteAsks) {
      pending.settle({ type: "unavailable" });
      cleanupRemoteAsk(requestId);
    }
  };

  const installAskRelay = (ctx: ExtensionContext): void => {
    if (askRelay) {
      askRelay.context = ctx;
      if (ctx.ui && ctx.ui.askDialog !== askRelay.relayAskDialog) {
        ctx.ui.askDialog = askRelay.relayAskDialog;
      }
      return;
    }
    if (!ctx.ui || typeof ctx.ui.askDialog !== "function") return;
    const askDialog = ctx.ui.askDialog;
    const describedAskDialog = Reflect.getOwnPropertyDescriptor(ctx.ui, "askDialog")?.value;
    const nativeAskDialog = typeof describedAskDialog === "function" ? describedAskDialog : askDialog;
    let relay!: AskRelay;
    const relayAskDialog = async (
      questions: ExtensionAskDialogQuestion[],
      dialogOptions?: ExtensionUIDialogOptions,
    ): Promise<ExtensionAskDialogResult | undefined> => {
      const requestId = crypto.randomUUID();
      const sessionId = relay.context.sessionManager.getSessionId();
      let resolveRemote!: (outcome: RemoteAskOutcome) => void;
      let resolveAbort!: () => void;
      const remote = new Promise<RemoteAskOutcome>((resolve) => {
        resolveRemote = resolve;
      });
      const parentAbort = new Promise<"aborted">((resolve) => {
        resolveAbort = () => resolve("aborted");
      });
      const timeout = dialogOptions?.timeout;
      const expiresAt =
        typeof timeout === "number" && timeout > 0 ? new Date(Date.now() + timeout).toISOString() : null;
      const request: AskRequest = {
        sessionId,
        requestId,
        kind: "rich",
        questions,
        expiresAt,
      };
      const pending: PendingRemoteAsk = {
        sessionId,
        request,
        relay,
        admitted: false,
        settled: false,
        admit() {
          if (this.admitted || this.settled) return;
          this.admitted = true;
        },
        settle(outcome) {
          if (this.settled) return;
          this.settled = true;
          resolveRemote(outcome);
        },
      };
      pendingRemoteAsks.set(requestId, pending);
      pending.unsubscribeTerminalInput = pending.relay.context.ui.onTerminalInput(() => {
        if (pendingRemoteAsks.get(requestId) !== pending || pending.settled) return undefined;
        if (typeof timeout === "number" && timeout > 0) {
          pending.request = {
            ...pending.request,
            expiresAt: new Date(Date.now() + timeout).toISOString(),
          };
        }
        if (pending.admitted) {
          send({ type: "ask_activity", sessionId: pending.sessionId, requestId });
        }
        return undefined;
      });
      const onParentAbort = () => resolveAbort();
      dialogOptions?.signal?.addEventListener("abort", onParentAbort, { once: true });
      if (dialogOptions?.signal?.aborted) resolveAbort();

      const localAbort = new AbortController();
      const localSignal = dialogOptions?.signal
        ? AbortSignal.any([dialogOptions.signal, localAbort.signal])
        : localAbort.signal;
      const localDialogOptions: ExtensionUIDialogOptions = { ...dialogOptions, signal: localSignal };
      const local = Promise.resolve(
        relay.nativeAskDialog.call(relay.context.ui, questions, localDialogOptions),
      ).then((value) => ({
        source: "local" as const,
        value,
      }));
      publishRemoteAsk(pending);

      const finishRemote = (outcome: Exclude<RemoteAskOutcome, { type: "unavailable" }>) => {
        cleanupRemoteAsk(requestId);
        if (outcome.type === "response") return outcome.response;
        dialogOptions?.onTimeout?.();
        return {
          kind: "submit" as const,
          results: questions.map((question) => {
            const selected = question.options[question.recommended ?? 0];
            return {
              id: question.id,
              question: question.question,
              options: question.options.map((option) => option.label),
              multi: question.multi ?? false,
              selectedOptions: selected ? [selected.label] : [],
              timedOut: true,
            };
          }),
        };
      };

      const winner = await Promise.race([
        local,
        remote.then((outcome) => ({ source: "remote" as const, outcome })),
        parentAbort.then(() => ({ source: "aborted" as const })),
      ]);
      if (winner.source === "aborted") {
        dialogOptions?.signal?.removeEventListener("abort", onParentAbort);
        localAbort.abort();
        cancelRemoteAsk(requestId);
        return undefined;
      }
      if (winner.source === "local") {
        dialogOptions?.signal?.removeEventListener("abort", onParentAbort);
        cancelRemoteAsk(requestId);
        return winner.value;
      }
      if (winner.outcome.type === "unavailable") {
        cleanupRemoteAsk(requestId);
        const fallback = await Promise.race([
          local,
          parentAbort.then(() => ({ source: "aborted" as const })),
        ]);
        dialogOptions?.signal?.removeEventListener("abort", onParentAbort);
        if (fallback.source === "aborted") {
          localAbort.abort();
          return undefined;
        }
        return fallback.value;
      }
      dialogOptions?.signal?.removeEventListener("abort", onParentAbort);
      localAbort.abort();
      return finishRemote(winner.outcome);
    };
    relay = {
      context: ctx,
      nativeAskDialog,
      relayAskDialog,
    };
    askRelay = relay;
    ctx.ui.askDialog = relayAskDialog;
  };

  const sessionSnapshot = (ctx: ExtensionContext) => {
    const snapshotToolCallTracker = new ExtensionToolCallTracker();
    producerReadImageResolver = createOwnReadImageResolver(TRANSCRIPT_IMAGE_SESSION_MAX_BYTES);
    const entries = ctx.sessionManager
      .getBranch()
      .map((entry) => SessionEntrySchema.safeParse(entry))
      .filter((entry) => entry.success)
      .map((entry) => entry.data);
    let firstPrompt: ExtensionTranscriptMessage | null = null;
    const ordinaryMessages: ExtensionTranscriptMessage[] = [];
    for (const entry of entries) {
      if (entry.type === "custom_message") {
        const prompt = normalizeSkillPromptRecord(
          entry,
          (text) => `skill-prompt-${createHash("sha256").update(text, "utf8").digest("hex")}`,
        );
        if (prompt && firstPrompt === null) {
          firstPrompt = normalizeMessage(
            { role: "user", content: prompt.text, id: prompt.id, timestamp: entry.timestamp },
            false,
            prompt.id,
            snapshotToolCallTracker,
          );
        }
        continue;
      }
      if (entry.type !== "message") continue;
      const message = normalizeMessage(entry.message, false, entry.id, snapshotToolCallTracker);
      if (message) ordinaryMessages.push(message);
    }
    const messages = ordinaryMessages.slice(-(firstPrompt ? 199 : 200));
    if (firstPrompt && !messages.some((message) => message.id === firstPrompt.id))
      messages.unshift(firstPrompt);
    const sessionId = ctx.sessionManager.getSessionId();
    if (firstPrompt) firstPromptIdBySession.set(sessionId, firstPrompt.id);
    else firstPromptIdBySession.delete(sessionId);
    const boundedMessages = boundExtensionTranscriptMessages(messages);
    messages.splice(0, messages.length, ...boundedMessages);
    retainedMessagesBySession.set(
      sessionId,
      new Map(boundedMessages.map((message) => [message.id, message])),
    );
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
      effort: pi.getThinkingLevel() ?? null,
      availableModels: getSessionModelOptions(ctx.models.list(), (role) => resolveRoleAssignment(ctx, role)),
      contextPercent: normalizeContextPercent(ctx),
      createdAt,
      lastActivity: now,
      capabilities: ["prompt", "steer", "follow_up", "abort", "resume", "model", "effort"] as const,
      messages,
      sessionPath: ctx.sessionManager.getSessionFile() ?? null,
      skillCommands: getSkillCommands(pi.getCommands()),
    };
  };

  const register = (): void => {
    if (!context) return;
    const session = sessionSnapshot(context);
    send({ type: "register", session });
    for (const pending of pendingRemoteAsks.values()) {
      if (pending.sessionId === session.id) publishRemoteAsk(pending);
    }
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
      const command: ExtensionCommand | null = (() => {
        try {
          const parsed = CommandSchema.parse(JSON.parse(String(event.data)));
          const canonical: ExtensionCommand = parsed;
          return canonical;
        } catch {
          return null;
        }
      })();
      if (!command) return;
      if (
        command.command === "ask_admitted" ||
        command.command === "ask_response" ||
        command.command === "ask_unavailable"
      ) {
        const pending = pendingRemoteAsks.get(command.requestId);
        if (!pending || socket !== nextSocket || pending.publishedSocket !== nextSocket) return;
        if (command.command === "ask_admitted") {
          pending.admit();
          return;
        }
        if (command.command === "ask_unavailable") {
          pending.settle({ type: "unavailable" });
          return;
        }
        const response: AskResponse = command.response;
        const parsedResponse = normalizeRemoteAskResponse(response);
        if (!parsedResponse) return;
        pending.settle(parsedResponse);
        return;
      }
      if (!context) return;
      try {
        if (command.command === "abort") context.abort();
        else if (command.command === "prompt") await pi.sendUserMessage(command.text);
        else if (command.command === "steer") {
          await pi.sendUserMessage(command.text, { deliverAs: "steer" });
        } else if (command.command === "follow_up") {
          await pi.sendUserMessage(command.text, { deliverAs: "followUp" });
        } else if (command.command === "set_model") {
          const model = context.models.resolve(command.model);
          if (!model) throw new Error(`Model ${command.model} is not available`);
          if (!(await pi.setModel(model))) throw new Error(`Model ${command.model} is not authenticated`);
          register();
        } else if (command.command === "set_effort") {
          pi.setThinkingLevel(command.effort as ExtensionThinkingLevel);
          register();
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
      disconnectRemoteAsks(nextSocket);
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
    const sessionId = context.sessionManager.getSessionId();
    const retained = retainedMessagesBySession.get(sessionId);
    const replacementId =
      typeof message === "object" && message !== null && "id" in message && typeof message.id === "string"
        ? message.id
        : activeMessageId;
    let retainedBytes = 0;
    for (const [retainedId, retainedMessage] of retained ?? []) {
      if (retainedId === replacementId || !retainedMessage.images) continue;
      for (const image of retainedMessage.images) retainedBytes += getTranscriptImageByteLength(image);
    }
    producerReadImageResolver = createOwnReadImageResolver(
      Math.max(0, TRANSCRIPT_IMAGE_SESSION_MAX_BYTES - retainedBytes),
    );
    const nextMessage = message ? normalizeMessage(message, streaming, activeMessageId) : null;
    const normalized = nextMessage ? boundLiveMessage(sessionId, nextMessage) : null;
    const model = context.models.current();
    send({
      type: "event",
      sessionId: context.sessionManager.getSessionId(),
      event,
      message: normalized,
      name: context.sessionManager.getSessionName() ?? null,
      model: model ? `${model.provider}/${model.id}` : null,
      contextPercent: normalizeContextPercent(context),
      effort: pi.getThinkingLevel() ?? null,
    });
  };

  const isTopLevelRpcSession = (ctx: ExtensionContext): boolean => {
    if (!rpcMode) return false;
    const sessionFile = ctx.sessionManager.getSessionFile();
    return !sessionFile?.endsWith(".jsonl") || !existsSync(`${dirname(sessionFile)}.jsonl`);
  };

  const sendMetadata = (): void => {
    const currentContext = metadataContext;
    if (!currentContext || metadataSocket?.readyState !== WebSocket.OPEN) return;
    metadataSocket.send(
      JSON.stringify({
        type: "metadata",
        sessionId: currentContext.sessionManager.getSessionId(),
        availableModels: getSessionModelOptions(currentContext.models.list(), (role) =>
          resolveRoleAssignment(currentContext, role),
        ),
      }),
    );
  };

  const connectMetadata = (): void => {
    if (
      !metadataActive ||
      !metadataContext ||
      metadataSocket?.readyState === WebSocket.CONNECTING ||
      metadataSocket?.readyState === WebSocket.OPEN
    ) {
      return;
    }
    const url = process.env.OMP_REMOTE_EXTENSION_URL ?? DEFAULT_EXTENSION_URL;
    const nextSocket = new WebSocket(url);
    metadataSocket = nextSocket;
    nextSocket.addEventListener("open", sendMetadata);
    nextSocket.addEventListener("close", () => {
      if (metadataSocket === nextSocket) metadataSocket = undefined;
      if (metadataActive && metadataContext) metadataContext.setTimeout(connectMetadata, RECONNECT_DELAY_MS);
    });
    nextSocket.addEventListener("error", () => nextSocket.close());
  };

  pi.on("session_start", async (_event, ctx) => {
    if (isTopLevelRpcSession(ctx)) {
      metadataContext = ctx;
      metadataActive = true;
      connectMetadata();
      ctx.setInterval(sendMetadata, HEARTBEAT_INTERVAL_MS);
      return;
    }
    context = ctx;
    active = true;
    installAskRelay(ctx);
    connect();
    ctx.setInterval(() => {
      const currentContext = context;
      if (!currentContext) return;
      const model = currentContext.models.current();
      send({
        type: "heartbeat",
        sessionId: currentContext.sessionManager.getSessionId(),
        name: currentContext.sessionManager.getSessionName() ?? null,
        model: model ? `${model.provider}/${model.id}` : null,
        contextPercent: normalizeContextPercent(currentContext),
        effort: pi.getThinkingLevel() ?? null,
        availableModels: getSessionModelOptions(currentContext.models.list(), (role) =>
          resolveRoleAssignment(currentContext, role),
        ),
        idle: currentContext.isIdle(),
        skillCommands: getSkillCommands(pi.getCommands()),
      });
    }, HEARTBEAT_INTERVAL_MS);
  });

  pi.on("session_switch", async (_event, ctx) => {
    if (isTopLevelRpcSession(ctx)) {
      metadataContext = ctx;
      sendMetadata();
      return;
    }
    context = ctx;
    installAskRelay(ctx);
    register();
  });
  pi.on("agent_start", async (_event, ctx) => {
    if (isTopLevelRpcSession(ctx)) return;
    context = ctx;
    installAskRelay(ctx);
    register();
    emitLifecycle("agent_start", null, false);
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (isTopLevelRpcSession(ctx)) return;
    context = ctx;
    installAskRelay(ctx);
    emitLifecycle("agent_end", null, false);
  });
  pi.on("message_start", async (event, ctx) => {
    if (isTopLevelRpcSession(ctx)) return;
    context = ctx;
    installAskRelay(ctx);
    activeMessageId = `extension-message-${++messageSequence}`;
    emitLifecycle("message_start", event.message, true);
  });
  pi.on("message_update", async (event, ctx) => {
    if (isTopLevelRpcSession(ctx)) return;
    context = ctx;
    installAskRelay(ctx);
    emitLifecycle("message_update", event.message, true);
  });
  pi.on("message_end", async (event, ctx) => {
    if (isTopLevelRpcSession(ctx)) return;
    context = ctx;
    installAskRelay(ctx);
    emitLifecycle("message_end", event.message, false);
    activeMessageId = undefined;
  });
  pi.on("session_shutdown", async () => {
    active = false;
    metadataActive = false;
    loseRemoteAsks();
    if (askRelay?.context.ui) askRelay.context.ui.askDialog = askRelay.nativeAskDialog;
    askRelay = undefined;
    socket?.close();
    socket = undefined;
    metadataSocket?.close();
    metadataSocket = undefined;
    context = undefined;
    metadataContext = undefined;
  });
}
