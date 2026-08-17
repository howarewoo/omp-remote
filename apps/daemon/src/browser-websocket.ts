import type { Logger } from "@omp-remote/observability";
import type { RpcFrame, RpcSession } from "@omp-remote/omp-rpc";
import {
  type ApplicationErrorInput,
  type AskRequest,
  type BrowserCommand,
  BrowserCommandSchema,
  type ServerFrame,
  type Session,
} from "@omp-remote/protocol";
import type { SessionRegistry } from "@omp-remote/sessions/services";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { type AskInactivityTimeout, isAskResponseValid, resetAskInactivityTimeout } from "./rpc-ask.js";
import type { PushSubscriptionStore } from "./push-subscriptions.js";
import type { SavedWorkingDirectoryStore } from "./saved-working-directories.js";
import type { ApplicationErrorStore } from "./application-error-store.js";

type PendingAsk = {
  request: AskRequest;
  source: "rpc" | "extension";
  timeout: AskInactivityTimeout | undefined;
};
export function removeBrowserSocket<T>(browserSockets: Set<T>, socket: T): void {
  browserSockets.delete(socket);
}

export function pendingAskRequestsForBrowserSnapshot(
  pendingAskBySession: ReadonlyMap<string, Pick<PendingAsk, "request">>,
): AskRequest[] {
  return [...pendingAskBySession.values()].map(({ request }) => request);
}

export function browserSnapshotSessions(sessions: readonly Session[]): Session[] {
  return sessions.filter((session) => session.connected).map((session) => ({ ...session, messages: [] }));
}

type BrowserWebSocketDependencies = {
  browserSockets: Set<WebSocket>;
  pendingAskBySession: Map<string, PendingAsk>;
  pushSubscriptions: PushSubscriptionStore;
  savedWorkingDirectories: SavedWorkingDirectoryStore;
  rpcSessions: Map<string, RpcSession>;
  extensionSockets: Map<string, WebSocket>;
  registry: SessionRegistry;
  sendToBrowser: (socket: WebSocket, frame: ServerFrame) => void;
  broadcast: (frame: ServerFrame) => void;
  launchRpcSession: (cwd: string, resume: string | null) => Promise<Session>;
  branchSwitchBlocksSessionCommand: (
    command: Extract<BrowserCommand, { type: "session_command" }>,
  ) => Promise<boolean>;
  switchSessionBranch: (command: Extract<BrowserCommand, { type: "switch_branch" }>) => Promise<void>;
  refreshRpcState: (sessionId: string, rpc: RpcSession) => Promise<void>;
  clearPendingAsk: (sessionId: string, requestId?: string) => void;
  expirePendingAsk: (sessionId: string, requestId: string, source: "rpc" | "extension") => void;
  originAllowed: (origin: string | undefined, host: string | undefined) => boolean;
  logger: Logger;
  errorStore?: ApplicationErrorStore;
};

type AskResponseCommand = Extract<BrowserCommand, { type: "ask_response" }>;
type AskResponseDependencies = {
  pendingAskBySession: Map<string, PendingAsk>;
  rpcSessions: Map<string, RpcSession>;
  extensionSockets: Map<string, WebSocket>;
  clearPendingAsk: (sessionId: string, requestId?: string) => void;
};

export async function respondToPendingAsk(
  command: AskResponseCommand,
  { pendingAskBySession, rpcSessions, extensionSockets, clearPendingAsk }: AskResponseDependencies,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pending = pendingAskBySession.get(command.sessionId);
  if (
    !pending ||
    pending.request.requestId !== command.askRequestId ||
    !isAskResponseValid(pending.request, command.response)
  ) {
    return { ok: false, error: "This question is no longer waiting for an answer." };
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
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "OMP rejected the answer" };
  }
}

export function registerBrowserWebSocketRoute(
  app: FastifyInstance,
  {
    pushSubscriptions,
    browserSockets,
    pendingAskBySession,
    savedWorkingDirectories,
    rpcSessions,
    extensionSockets,
    registry,
    sendToBrowser,
    broadcast,
    launchRpcSession,
    branchSwitchBlocksSessionCommand,
    switchSessionBranch,
    refreshRpcState,
    clearPendingAsk,
    expirePendingAsk,
    originAllowed,
    logger,
    errorStore,
  }: BrowserWebSocketDependencies,
): void {
  app.get("/ws", { websocket: true }, (socket, request) => {
    if (!originAllowed(request.headers.origin, request.headers.host)) {
      socket.close(1008, "Origin is not allowed");
      return;
    }
    browserSockets.add(socket);
    sendToBrowser(socket, {
      type: "snapshot",
      sessions: browserSnapshotSessions(registry.list()),
      askRequests: pendingAskRequestsForBrowserSnapshot(pendingAskBySession),
      savedWorkingDirectories: savedWorkingDirectories.list(),
    });
    socket.on("message", async (raw) => {
      const command = (() => {
        try {
          return BrowserCommandSchema.parse(JSON.parse(raw.toString()));
        } catch (error) {
          logger.warn("Rejected dashboard command", {
            error: error instanceof Error ? error.message : String(error),
          });
          sendToBrowser(socket, { type: "error", message: "The dashboard command was not valid." });
          return null;
        }
      })();
      if (!command) return;
      if (
        command.type === "push_vapid_public_key" ||
        command.type === "push_subscription_register" ||
        command.type === "push_subscription_update" ||
        command.type === "push_subscription_remove"
      ) {
        try {
          if (command.type === "push_vapid_public_key")
            sendToBrowser(socket, {
              type: "command_result",
              requestId: command.requestId,
              outcome: {
                status: "ok",
                value: { type: "push_vapid_public_key", publicKey: pushSubscriptions.publicKey },
              },
            });
          else {
            if (command.type === "push_subscription_register")
              await pushSubscriptions.register({
                deviceId: command.deviceId,
                subscription: command.subscription,
                events: command.events,
              });
            else if (command.type === "push_subscription_update")
              await pushSubscriptions.update({
                deviceId: command.deviceId,
                subscription: command.subscription,
                events: command.events,
              });
            else await pushSubscriptions.remove({ deviceId: command.deviceId });
            sendToBrowser(socket, {
              type: "command_result",
              requestId: command.requestId,
              outcome: { status: "ok", value: { type: "void" } },
            });
          }
        } catch (error) {
          sendToBrowser(socket, {
            type: "command_result",
            requestId: command.requestId,
            outcome: {
              status: "error",
              error: error instanceof Error ? error.message : "Push subscription could not be updated",
            },
          });
        }
        return;
      }

      if (command.type === "report_application_error") {
        if (!errorStore) {
          sendToBrowser(socket, {
            type: "command_result",
            requestId: command.requestId,
            outcome: {
              status: "error",
              error: "Application error reporting is unavailable",
            },
          });
          return;
        }
        try {
          const errorPayload = "error" in command ? command.error : command;
          const input: ApplicationErrorInput = {
            source: "browser",
            severity: errorPayload.severity ?? "error",
            message: errorPayload.message,
            ...(errorPayload.errorName ? { errorName: errorPayload.errorName } : {}),
            ...(errorPayload.stack ? { stack: errorPayload.stack } : {}),
            ...(errorPayload.context ? { context: errorPayload.context } : {}),
            ...(errorPayload.id ? { id: errorPayload.id } : {}),
            ...(errorPayload.timestamp ? { timestamp: errorPayload.timestamp } : {}),
          };
          const record = await errorStore.record(input);
          broadcast({
            type: "application_error_added",
            error: record,
          });
          sendToBrowser(socket, {
            type: "command_result",
            requestId: command.requestId,
            outcome: { status: "ok", value: { type: "void" } },
          });
        } catch (error) {
          logger.warn("Failed to record browser application error", {
            requestId: command.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
          sendToBrowser(socket, {
            type: "command_result",
            requestId: command.requestId,
            outcome: {
              status: "error",
              error: error instanceof Error ? error.message : "Application error could not be recorded",
            },
          });
        }
        return;
      }

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
            scope: "command",
            cwd: command.cwd,
            operation: command.type,
          });
          sendToBrowser(socket, {
            type: "command_result",
            requestId: command.requestId,
            outcome: {
              status: "error",
              error:
                error instanceof Error ? error.message : "Saved working directories could not be updated",
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
          logger.error("Failed to launch OMP RPC session", error, { scope: "command", cwd: command.cwd });
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
        const response = await respondToPendingAsk(command, {
          pendingAskBySession,
          rpcSessions,
          extensionSockets,
          clearPendingAsk,
        });
        sendToBrowser(socket, {
          type: "command_result",
          requestId: command.requestId,
          outcome: response.ok
            ? { status: "ok", value: { type: "void" } }
            : { status: "error", error: response.error },
        });
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
            scope: "command",
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
      removeBrowserSocket(browserSockets, socket);
    });
  });
}
