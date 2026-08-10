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
  type AskResponse,
  type ExtensionCommand,
  getTranscriptImageByteLength,
  TRANSCRIPT_IMAGE_MAX_BYTES,
  TRANSCRIPT_IMAGE_SESSION_MAX_BYTES,
  type TranscriptImage,
  type TranscriptImageMimeType,
  type TranscriptMessage,
  validateTranscriptImageBytes,
} from "@omp-remote/protocol";
import {
  boundExtensionTranscriptMessages,
  ExtensionToolCallTracker,
  normalizeExtensionMessage,
} from "./transcript-normalizer.js";
import { getConfiguredRoleEffort, getSessionModelOptions, getComposerCommands } from "./model-options.js";
import { normalizeRemoteAskResponse, type RemoteAskOutcome } from "./remote-ask.js";

export {
  boundExtensionTranscriptMessages,
  ExtensionToolCallTracker,
  materializeExtensionReadImages,
  normalizeExtensionMessage,
} from "./transcript-normalizer.js";
export { getConfiguredRoleEffort, getSessionModelOptions, getComposerCommands } from "./model-options.js";
export { normalizeRemoteAskResponse } from "./remote-ask.js";

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
      question: z.string().min(1),
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
  const SessionEntrySchema = z
    .object({ id: z.string(), type: z.literal("message"), message: z.unknown() })
    .passthrough();
  const sessionCreatedAt = new Map<string, string>();
  type AskRelay = {
    context: ExtensionContext;
    nativeAskDialog: NonNullable<ExtensionContext["ui"]["askDialog"]>;
  };
  type PendingRemoteAsk = {
    sessionId: string;
    relay: AskRelay;
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
  let active = false;
  let activeMessageId: string | undefined;
  let messageSequence = 0;
  const liveToolCallTracker = new ExtensionToolCallTracker();
  let producerReadImageResolver: (data: string, mimeType: string) => TranscriptImage = resolveOwnReadImage;
  const retainedMessagesBySession = new Map<string, Map<string, ExtensionTranscriptMessage>>();

  const boundLiveMessage = (
    sessionId: string,
    message: ExtensionTranscriptMessage,
  ): ExtensionTranscriptMessage => {
    const retained =
      retainedMessagesBySession.get(sessionId) ?? new Map<string, ExtensionTranscriptMessage>();
    retained.set(message.id, message);
    while (retained.size > 200) {
      const oldestId = retained.keys().next().value;
      if (oldestId === undefined) break;
      retained.delete(oldestId);
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
      return;
    }
    if (!ctx.ui) return;
    const existing = Reflect.getOwnPropertyDescriptor(ctx.ui, "askDialog")?.value as
      | NonNullable<ExtensionContext["ui"]["askDialog"]>
      | undefined;
    if (!existing) return;
    const relay: AskRelay = {
      context: ctx,
      nativeAskDialog: existing,
    };
    askRelay = relay;
    ctx.ui.askDialog = async (
      questions: ExtensionAskDialogQuestion[],
      dialogOptions?: ExtensionUIDialogOptions,
    ): Promise<ExtensionAskDialogResult | undefined> => {
      const localAskDialog = (
        localQuestions: ExtensionAskDialogQuestion[],
        localOptions?: ExtensionUIDialogOptions,
      ) => relay.nativeAskDialog.call(relay.context.ui, localQuestions, localOptions);
      if (socket?.readyState !== WebSocket.OPEN) return localAskDialog(questions, dialogOptions);

      const requestId = crypto.randomUUID();
      const sessionId = relay.context.sessionManager.getSessionId();
      let resolveAdmission!: () => void;
      let resolveRemote!: (outcome: RemoteAskOutcome) => void;
      let resolveAbort!: () => void;
      const admission = new Promise<void>((resolve) => {
        resolveAdmission = resolve;
      });
      const remote = new Promise<RemoteAskOutcome>((resolve) => {
        resolveRemote = resolve;
      });
      const parentAbort = new Promise<"aborted">((resolve) => {
        resolveAbort = () => resolve("aborted");
      });
      const pending: PendingRemoteAsk = {
        sessionId,
        relay,
        admitted: false,
        settled: false,
        admit() {
          if (this.admitted || this.settled) return;
          this.admitted = true;
          this.unsubscribeTerminalInput = this.relay.context.ui.onTerminalInput(() => {
            if (pendingRemoteAsks.get(requestId) === this && this.admitted && !this.settled) {
              send({ type: "ask_activity", sessionId: this.sessionId, requestId });
            }
            return undefined;
          });
          resolveAdmission();
        },
        settle(outcome) {
          if (this.settled) return;
          this.settled = true;
          resolveRemote(outcome);
        },
      };
      pendingRemoteAsks.set(requestId, pending);
      const onParentAbort = () => resolveAbort();
      dialogOptions?.signal?.addEventListener("abort", onParentAbort, { once: true });
      if (dialogOptions?.signal?.aborted) resolveAbort();
      const timeout = dialogOptions?.timeout;
      const expiresAt =
        typeof timeout === "number" && timeout > 0 ? new Date(Date.now() + timeout).toISOString() : null;
      send({
        type: "ask_request",
        request: { sessionId, requestId, kind: "rich", questions, expiresAt },
      });

      const remoteResult = async (
        outcome: RemoteAskOutcome,
      ): Promise<ExtensionAskDialogResult | undefined> => {
        cleanupRemoteAsk(requestId);
        if (outcome.type === "unavailable") return localAskDialog(questions, dialogOptions);
        if (outcome.type === "response") return outcome.response;
        dialogOptions?.onTimeout?.();
        return {
          kind: "submit",
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

      const first = await Promise.race([
        admission.then(() => ({ source: "admitted" as const })),
        remote.then((outcome) => ({ source: "remote" as const, outcome })),
        parentAbort.then(() => ({ source: "aborted" as const })),
      ]);
      if (first.source === "aborted") {
        cancelRemoteAsk(requestId);
        dialogOptions?.signal?.removeEventListener("abort", onParentAbort);
        return undefined;
      }
      if (first.source === "remote") {
        dialogOptions?.signal?.removeEventListener("abort", onParentAbort);
        return remoteResult(first.outcome);
      }

      const localAbort = new AbortController();
      const localSignal = dialogOptions?.signal
        ? AbortSignal.any([dialogOptions.signal, localAbort.signal])
        : localAbort.signal;
      const localDialogOptions: ExtensionUIDialogOptions = { ...dialogOptions, signal: localSignal };
      delete localDialogOptions.timeout;
      delete localDialogOptions.onTimeout;
      delete localDialogOptions.onTimeoutStart;
      delete localDialogOptions.onTimeoutReset;
      const local = localAskDialog(questions, localDialogOptions).then((value) => ({
        source: "local" as const,
        value,
      }));
      const winner = await Promise.race([
        local,
        remote.then((outcome) => ({ source: "remote" as const, outcome })),
        parentAbort.then(() => ({ source: "aborted" as const })),
      ]);
      dialogOptions?.signal?.removeEventListener("abort", onParentAbort);
      if (winner.source === "aborted") {
        localAbort.abort();
        cancelRemoteAsk(requestId);
        return undefined;
      }
      if (winner.source === "local") {
        cancelRemoteAsk(requestId);
        return winner.value;
      }
      localAbort.abort();
      return remoteResult(winner.outcome);
    };
  };

  const sessionSnapshot = (ctx: ExtensionContext) => {
    const snapshotToolCallTracker = new ExtensionToolCallTracker();
    producerReadImageResolver = createOwnReadImageResolver(TRANSCRIPT_IMAGE_SESSION_MAX_BYTES);
    const messages = ctx.sessionManager
      .getBranch()
      .slice(-200)
      .map((entry) => SessionEntrySchema.safeParse(entry))
      .filter((entry) => entry.success)
      .map((entry) => normalizeMessage(entry.data.message, false, entry.data.id, snapshotToolCallTracker))
      .filter((message) => message !== null)
      .slice(-200);
    const sessionId = ctx.sessionManager.getSessionId();
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
      composerCommands: getComposerCommands(pi.getCommands()),
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
        if (!pending) return;
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
      loseRemoteAsks();
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

  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (rpcMode && (!sessionFile?.endsWith(".jsonl") || !existsSync(`${dirname(sessionFile)}.jsonl`))) return;
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
        composerCommands: getComposerCommands(pi.getCommands()),
      });
    }, HEARTBEAT_INTERVAL_MS);
  });

  pi.on("session_switch", async (_event, ctx) => {
    loseRemoteAsks();
    context = ctx;
    installAskRelay(ctx);
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
    loseRemoteAsks();
    if (askRelay) askRelay.context.ui.askDialog = askRelay.nativeAskDialog;
    askRelay = undefined;
    socket?.close();
    socket = undefined;
    context = undefined;
  });
}
