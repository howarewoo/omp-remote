/// <reference lib="es2024.promise" />

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ServerFrame, Session } from "@omp-remote/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const execFileAsync = promisify(execFile);
const daemonDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const temporaryDirectories: string[] = [];
let daemon: ChildProcess | undefined;
let daemonPort: number;
let historyDirectory: string;

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a daemon test port");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "omp-remote-branch-integration-"));
  temporaryDirectories.push(repository);
  await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repository });
  await writeFile(join(repository, "tracked.txt"), "main\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "main"], { cwd: repository });
  await execFileAsync("git", ["branch", "feature/target"], { cwd: repository });
  return repository;
}

function session(id: string, cwd: string, status: Session["status"] = "idle"): Session {
  const timestamp = new Date().toISOString();
  return {
    id,
    source: "extension",
    name: id,
    cwd,
    branch: "main",
    status,
    connected: true,
    model: null,
    contextPercent: null,
    createdAt: timestamp,
    lastActivity: timestamp,
    capabilities: [],
    messages: [],
    sessionPath: null,
    parentSessionId: null,
    activeSubagents: [],
    skillCommands: [],
  };
}

async function openSocket(
  path: string,
  options?: ConstructorParameters<typeof WebSocket>[2],
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${daemonPort}${path}`, options);
  await once(socket, "open");
  return socket;
}

async function registerExtension(value: Session): Promise<WebSocket> {
  const socket = await openSocket("/extension");
  socket.send(JSON.stringify({ type: "register", session: value }));
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/${value.id}/branches`);
    if (response.status === 404) throw new Error("Session registration has not propagated");
  });
  return socket;
}

function collectFrames(socket: WebSocket): ServerFrame[] {
  const frames: ServerFrame[] = [];
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as ServerFrame;
    frames.push(frame);
  });
  return frames;
}

function nextEventLoopTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

async function waitUntil(assertion: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await nextEventLoopTurn();
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for daemon state");
}

async function currentBranch(repository: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: repository });
  return stdout.trim();
}

beforeAll(async () => {
  daemonPort = await availablePort();
  historyDirectory = await mkdtemp(join(tmpdir(), "omp-remote-empty-history-"));
  temporaryDirectories.push(historyDirectory);
  const rpcFixture = join(historyDirectory, "rpc-fixture.cjs");
  const rpcSessionPath = join(historyDirectory, "sessions", "integration", "rpc-integration.jsonl");
  await mkdir(dirname(rpcSessionPath), { recursive: true });
  await writeFile(
    rpcSessionPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "rpc-integration",
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
      title: "RPC integration",
    })}\n`,
  );
  await writeFile(
    rpcFixture,
    `#!/usr/bin/env node
const readline = require("node:readline");
process.stdout.write(JSON.stringify({ type: "ready", supportedProtocolVersions: [] }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  let data;
  if (frame.type === "get_state") data = { sessionId: "rpc-integration", isStreaming: false };
  else if (frame.type === "get_available_commands") data = { commands: [] };
  else if (frame.type === "get_available_models") data = { models: [] };
  else if (frame.type === "get_messages") data = [];
  else data = {};
  process.stdout.write(JSON.stringify({ type: "response", command: frame.type, id: frame.id, success: true, data }) + "\\n");
});
`,
  );
  await chmod(rpcFixture, 0o755);
  const graphiteFixture = join(historyDirectory, "gt");
  await writeFile(
    graphiteFixture,
    "#!/bin/sh\nif [ -f .slow-topology ]; then\n  printf x >> .gt-calls\n  sleep 1\nfi\nexit 1\n",
  );
  await chmod(graphiteFixture, 0o755);
  const startedDaemon = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: daemonDirectory,
    env: {
      ...process.env,
      OMP_REMOTE_HOST: "127.0.0.1",
      PATH: `${historyDirectory}:${process.env.PATH ?? ""}`,
      OMP_REMOTE_PORT: String(daemonPort),
      PI_CODING_AGENT_DIR: historyDirectory,
      OMP_REMOTE_OMP_PATH: rpcFixture,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon = startedDaemon;
  let output = "";
  startedDaemon.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  startedDaemon.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  await waitUntil(async () => {
    if (startedDaemon.exitCode !== null) throw new Error(`Daemon exited during startup: ${output}`);
    const response = await fetch(`http://127.0.0.1:${daemonPort}/healthz`).catch(() => null);
    if (!response?.ok) throw new Error(`Daemon is not ready: ${output}`);
  }, 15_000);
}, 20_000);

afterAll(async () => {
  if (daemon?.exitCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill("SIGTERM");
    await exited;
  }
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("session transcript fallback integration", () => {
  it("serves an exact live-registry transcript when catalog history is absent", async () => {
    const repository = await createRepository();
    const live = await registerExtension({
      ...session("transcript-live-fallback", repository),
      messages: [
        {
          id: "live-message",
          role: "assistant",
          text: "Live transcript",
          timestamp: "2026-08-01T00:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      ],
    });

    const response = await fetch(
      `http://127.0.0.1:${daemonPort}/api/sessions/transcript-live-fallback/transcript`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: "transcript-live-fallback",
      messages: [{ id: "live-message", text: "Live transcript" }],
    });
    const missingResponse = await fetch(
      `http://127.0.0.1:${daemonPort}/api/sessions/unrelated-missing-session/transcript`,
    );
    expect(missingResponse.status).toBe(404);
    live.close();
  });
});

describe("session cost fallback integration", () => {
  it("serves null cost for a live session while catalog history is absent", async () => {
    const repository = await createRepository();
    const live = await registerExtension(session("cost-live-fallback", repository));
    try {
      const response = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/cost-live-fallback/cost`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        sessionId: "cost-live-fallback",
        costSummary: null,
      });
      const missingResponse = await fetch(
        `http://127.0.0.1:${daemonPort}/api/sessions/unrelated-missing-session/cost`,
      );
      expect(missingResponse.status).toBe(404);
    } finally {
      live.close();
    }
  });
});

describe("extension session idle authority integration", () => {
  it("preserves running status through early agent_end and becomes idle only after idle heartbeat", async () => {
    const repository = await createRepository();
    const extension = await registerExtension(session("extension-idle-authority", repository, "running"));
    try {
      const initialResponse = await fetch(
        `http://127.0.0.1:${daemonPort}/api/sessions/extension-idle-authority`,
      );
      expect(initialResponse.status).toBe(200);
      await expect(initialResponse.json()).resolves.toMatchObject({
        id: "extension-idle-authority",
        status: "running",
      });

      extension.send(
        JSON.stringify({
          type: "event",
          sessionId: "extension-idle-authority",
          event: "agent_end",
          message: {
            id: "msg-agent-end",
            role: "assistant",
            text: "Agent finished turn",
            timestamp: "2026-08-01T00:00:00.000Z",
            streaming: false,
            presentation: "text",
          },
          name: "extension-idle-authority",
          model: "claude-3-5-sonnet",
          contextPercent: 42,
          effort: "high",
        }),
      );

      await waitUntil(async () => {
        const response = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/extension-idle-authority`);
        expect(response.status).toBe(200);
        const data = (await response.json()) as Session;
        expect(data).toMatchObject({
          id: "extension-idle-authority",
          status: "running",
          model: "claude-3-5-sonnet",
          contextPercent: 42,
          effort: "high",
        });
        expect(data.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "msg-agent-end", text: "Agent finished turn" }),
          ]),
        );
      });

      extension.send(
        JSON.stringify({
          type: "heartbeat",
          sessionId: "extension-idle-authority",
          name: "extension-idle-authority",
          model: "claude-3-5-sonnet",
          contextPercent: 45,
          idle: false,
        }),
      );

      await waitUntil(async () => {
        const response = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/extension-idle-authority`);
        expect(response.status).toBe(200);
        const data = (await response.json()) as Session;
        expect(data).toMatchObject({
          id: "extension-idle-authority",
          status: "running",
          contextPercent: 45,
        });
      });

      extension.send(
        JSON.stringify({
          type: "heartbeat",
          sessionId: "extension-idle-authority",
          name: "extension-idle-authority",
          model: "claude-3-5-sonnet",
          contextPercent: 45,
          idle: true,
        }),
      );

      await waitUntil(async () => {
        const response = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/extension-idle-authority`);
        expect(response.status).toBe(200);
        const data = (await response.json()) as Session;
        expect(data).toMatchObject({
          id: "extension-idle-authority",
          status: "idle",
          contextPercent: 45,
        });
      });

      extension.send(
        JSON.stringify({
          type: "event",
          sessionId: "extension-idle-authority",
          event: "agent_start",
          message: null,
          name: "extension-idle-authority",
          model: "claude-3-5-sonnet",
          contextPercent: 48,
          effort: "high",
        }),
      );

      await waitUntil(async () => {
        const response = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/extension-idle-authority`);
        expect(response.status).toBe(200);
        const data = (await response.json()) as Session;
        expect(data).toMatchObject({
          id: "extension-idle-authority",
          status: "running",
          contextPercent: 48,
        });
      });
    } finally {
      extension.close();
    }
  });
});

describe("exact session details integration", () => {
  it("refreshes catalog-only child details, keeps pages root-only, prefers live state, and bounds output", async () => {
    const sessionsDirectory = join(historyDirectory, "sessions", "details-project");
    const rootPath = join(sessionsDirectory, "details-root.jsonl");
    const childPath = join(sessionsDirectory, "details-root", "details-child.jsonl");
    const grandchildPath = join(
      sessionsDirectory,
      "details-root",
      "details-child",
      "details-grandchild.jsonl",
    );
    const header = (id: string, title: string, timestamp: string) => [
      JSON.stringify({ type: "title", v: 1, title, updatedAt: timestamp }),
      JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp,
        cwd: "/workspace/details",
        title,
      }),
    ];
    const records = Array.from({ length: 205 }, (_, index) =>
      JSON.stringify({
        type: "message",
        id: `details-message-${index}`,
        timestamp:
          [
            "2026-08-01T10",
            String(Math.floor(index / 60)).padStart(2, "0"),
            String(index % 60).padStart(2, "0"),
          ].join(":") + ".000Z",
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: [
            {
              type: "text",
              text: index === 5 ? "x".repeat(20_001) : `Saved detail ${index}`,
            },
          ],
        },
      }),
    );
    await mkdir(dirname(rootPath), { recursive: true });
    await mkdir(dirname(childPath), { recursive: true });
    await mkdir(dirname(grandchildPath), { recursive: true });
    await writeFile(
      rootPath,
      `${header("details-root", "Details root", "2026-08-01T10:00:00.000Z").join("\n")}\n`,
    );
    await writeFile(
      childPath,
      `${[...header("details-child", "Details child", "2026-08-01T10:01:00.000Z"), ...records].join("\n")}\n`,
    );
    await writeFile(
      grandchildPath,
      `${header("details-grandchild", "Details grandchild", "2026-08-01T10:02:00.000Z").join("\n")}\n`,
    );

    const detailsResponse = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/details-child`);
    expect(detailsResponse.status).toBe(200);
    const details = (await detailsResponse.json()) as Session;
    expect(details).toMatchObject({
      id: "details-child",
      source: "history",
      parentSessionId: "details-root",
    });
    expect(details.messages).toHaveLength(200);
    expect(details.messages[0]).toMatchObject({
      id: "details-message-5",
      text: `${"x".repeat(20_000)}…`,
    });

    const catalogResponse = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions`);
    const catalog = (await catalogResponse.json()) as { sessions: Session[] };
    expect(catalog.sessions.map((catalogSession) => catalogSession.id)).toContain("details-root");
    expect(catalog.sessions.map((catalogSession) => catalogSession.id)).not.toContain("details-child");
    expect(catalog.sessions.map((catalogSession) => catalogSession.id)).not.toContain("details-grandchild");

    const repository = await createRepository();
    const liveMessages: Session["messages"] = Array.from({ length: 205 }, (_, index) => ({
      id: `live-detail-${index}`,
      role: "assistant",
      text: `Live detail ${index}`,
      timestamp:
        [
          "2026-08-01T11",
          String(Math.floor(index / 60)).padStart(2, "0"),
          String(index % 60).padStart(2, "0"),
        ].join(":") + ".000Z",
      streaming: index === 204,
      presentation: "text",
      ...(index === 204
        ? {
            images: [
              {
                status: "available" as const,
                mimeType: "image/png" as const,
                data: Buffer.from("not a png").toString("base64"),
              },
            ],
          }
        : {}),
    }));
    const live = await registerExtension({
      ...session("details-child", repository, "running"),
      name: "Live details child",
      parentSessionId: "details-root",
      messages: liveMessages,
    });
    try {
      const liveResponse = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/details-child`);
      expect(liveResponse.status).toBe(200);
      const liveDetails = (await liveResponse.json()) as Session;
      expect(liveDetails).toMatchObject({
        id: "details-child",
        source: "extension",
        name: "Live details child",
        status: "running",
        parentSessionId: "details-root",
      });
      expect(liveDetails.messages).toHaveLength(200);
      expect(liveDetails.messages.at(-1)).toMatchObject({
        id: "live-detail-204",
        streaming: true,
        images: [{ status: "unavailable", reason: "mime_mismatch" }],
      });
    } finally {
      live.close();
    }

    const unknown = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/unknown-details-child`);
    expect(unknown.status).toBe(404);
    const malformed = await fetch(
      `http://127.0.0.1:${daemonPort}/api/sessions/${encodeURIComponent("malformed/id")}`,
    );
    expect(malformed.status).toBe(404);
  });
});

describe("session branch daemon integration", () => {
  it("serves live topology and rejects detached or missing sessions", async () => {
    const repository = await createRepository();
    const extension = await registerExtension(session("topology-live", repository));

    const response = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/topology-live/branches`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: "topology-live",
      currentBranch: "main",
      branches: expect.arrayContaining([{ name: "main" }, { name: "feature/target", parent: "main" }]),
    });

    const missing = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/missing/branches`);
    expect(missing.status).toBe(404);

    const detachedRepository = await createRepository();
    await execFileAsync("git", ["checkout", "--detach"], { cwd: detachedRepository });
    const detachedExtension = await registerExtension(session("topology-detached", detachedRepository));
    const detached = await fetch(`http://127.0.0.1:${daemonPort}/api/sessions/topology-detached/branches`);
    expect(detached.status).toBe(409);

    extension.close();
    detachedExtension.close();
  });

  it("coalesces same-worktree topology loads and limits daemon-wide concurrency", async () => {
    const sharedRepository = await createRepository();
    await writeFile(join(sharedRepository, ".slow-topology"), "");
    const first = await registerExtension(session("topology-shared-first", sharedRepository));
    const second = await registerExtension(session("topology-shared-second", sharedRepository));
    await writeFile(join(sharedRepository, ".gt-calls"), "");

    const sharedResponses = await Promise.all([
      fetch(`http://127.0.0.1:${daemonPort}/api/sessions/topology-shared-first/branches`),
      fetch(`http://127.0.0.1:${daemonPort}/api/sessions/topology-shared-second/branches`),
    ]);
    expect(sharedResponses.map((response) => response.status)).toEqual([200, 200]);
    await expect(readFile(join(sharedRepository, ".gt-calls"), "utf8")).resolves.toBe("x");

    const capacitySessions = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const repository = await createRepository();
        await writeFile(join(repository, ".slow-topology"), "");
        return registerExtension(session(`topology-capacity-${index}`, repository));
      }),
    );
    const capacityResponses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        fetch(`http://127.0.0.1:${daemonPort}/api/sessions/topology-capacity-${index}/branches`),
      ),
    );
    expect(capacityResponses.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 503]);

    first.close();
    second.close();
    for (const extension of capacitySessions) extension.close();
  }, 20_000);

  it("binds remote WebSocket origins to the requested Tailscale host", async () => {
    const rejected = await openSocket("/ws", {
      origin: "https://attacker.ts.net",
      headers: { host: "victim.ts.net" },
    });
    const rejectedClose = once(rejected, "close");
    const [code] = await rejectedClose;
    expect(code).toBe(1008);

    const insecure = await openSocket("/ws", {
      origin: "http://victim.ts.net",
      headers: { host: "victim.ts.net" },
    });
    const insecureClose = once(insecure, "close");
    const [insecureCode] = await insecureClose;
    expect(insecureCode).toBe(1008);

    const accepted = new WebSocket(`ws://127.0.0.1:${daemonPort}/ws`, {
      origin: "https://victim.ts.net",
      headers: { host: "victim.ts.net" },
    });
    const frames = collectFrames(accepted);
    await once(accepted, "open");
    await waitUntil(() => expect(frames.some((frame) => frame.type === "snapshot")).toBe(true));
    accepted.close();
  });

  it("switches extension sessions, refreshes sibling metadata, and enforces live state", async () => {
    const repository = await createRepository();
    const first = await registerExtension(session("switch-first", repository));
    const sibling = await registerExtension(session("switch-sibling", repository));
    const runningRepository = await createRepository();
    const running = await registerExtension(session("switch-running", runningRepository, "running"));
    const browser = await openSocket("/ws", { origin: "http://127.0.0.1:5173" });
    const frames = collectFrames(browser);

    browser.send(
      JSON.stringify({
        type: "switch_branch",
        requestId: "switch-success",
        sessionId: "switch-first",
        branch: "feature/target",
      }),
    );
    await waitUntil(() => {
      expect(
        frames.some(
          (frame) =>
            frame.type === "command_result" &&
            frame.requestId === "switch-success" &&
            frame.outcome.status === "ok",
        ),
      ).toBe(true);
      for (const sessionId of ["switch-first", "switch-sibling"]) {
        expect(
          frames.some(
            (frame) =>
              frame.type === "session_update" &&
              frame.sessionId === sessionId &&
              frame.patch.branch === "feature/target",
          ),
        ).toBe(true);
      }
    });
    await expect(currentBranch(repository)).resolves.toBe("feature/target");

    const runningSibling = await registerExtension(session("switch-running-sibling", repository, "running"));
    browser.send(
      JSON.stringify({
        type: "switch_branch",
        requestId: "switch-with-running-sibling",
        sessionId: "switch-first",
        branch: "main",
      }),
    );
    await waitUntil(() =>
      expect(
        frames.some(
          (frame) =>
            frame.type === "command_result" &&
            frame.requestId === "switch-with-running-sibling" &&
            frame.outcome.status === "error" &&
            frame.outcome.error?.includes("running") === true,
        ),
      ).toBe(true),
    );
    await expect(currentBranch(repository)).resolves.toBe("feature/target");
    runningSibling.close();

    browser.send(
      JSON.stringify({
        type: "switch_branch",
        requestId: "switch-running",
        sessionId: "switch-running",
        branch: "feature/target",
      }),
    );
    await waitUntil(() =>
      expect(
        frames.some(
          (frame) =>
            frame.type === "command_result" &&
            frame.requestId === "switch-running" &&
            frame.outcome.status === "error" &&
            frame.outcome.error?.includes("running") === true,
        ),
      ).toBe(true),
    );
    await expect(currentBranch(runningRepository)).resolves.toBe("main");

    first.close();
    await once(first, "close");
    await waitUntil(() =>
      expect(
        frames.some(
          (frame) =>
            frame.type === "session_update" &&
            frame.sessionId === "switch-first" &&
            frame.patch.connected === false,
        ),
      ).toBe(true),
    );
    browser.send(
      JSON.stringify({
        type: "switch_branch",
        requestId: "switch-disconnected",
        sessionId: "switch-first",
        branch: "main",
      }),
    );
    await waitUntil(() =>
      expect(
        frames.some(
          (frame) =>
            frame.type === "command_result" &&
            frame.requestId === "switch-disconnected" &&
            frame.outcome.status === "error",
        ),
      ).toBe(true),
    );
    await expect(currentBranch(repository)).resolves.toBe("feature/target");

    sibling.close();
    running.close();
    browser.close();
  });

  it("switches a daemon-hosted RPC session after confirming idle state", async () => {
    const repository = await createRepository();
    const browser = await openSocket("/ws", { origin: "http://127.0.0.1:5173" });
    const frames = collectFrames(browser);

    browser.send(
      JSON.stringify({
        type: "launch",
        requestId: "launch-rpc",
        cwd: repository,
        resume: null,
      }),
    );
    await waitUntil(() => {
      const result = frames.find(
        (frame) => frame.type === "command_result" && frame.requestId === "launch-rpc",
      );
      if (
        result?.type !== "command_result" ||
        result.outcome.status !== "ok" ||
        result.outcome.value.type !== "launch" ||
        result.outcome.value.sessionId !== "rpc-integration"
      ) {
        throw new Error(`RPC launch did not succeed: ${JSON.stringify(frames)}`);
      }
    });

    browser.send(
      JSON.stringify({
        type: "switch_branch",
        requestId: "switch-rpc",
        sessionId: "rpc-integration",
        branch: "feature/target",
      }),
    );
    await waitUntil(() =>
      expect(
        frames.some(
          (frame) =>
            frame.type === "command_result" &&
            frame.requestId === "switch-rpc" &&
            frame.outcome.status === "ok",
        ),
      ).toBe(true),
    );
    await expect(currentBranch(repository)).resolves.toBe("feature/target");

    browser.send(
      JSON.stringify({
        type: "session_command",
        requestId: "kill-rpc",
        sessionId: "rpc-integration",
        command: "kill",
      }),
    );
    await waitUntil(() =>
      expect(frames.some((frame) => frame.type === "command_result" && frame.requestId === "kill-rpc")).toBe(
        true,
      ),
    );
    browser.close();
  });

  it("does not patch a same-ID replacement registered during checkout", async () => {
    const repository = await createRepository();
    const replacementRepository = await createRepository();
    const hook = join(repository, ".git", "hooks", "post-checkout");
    const checkoutStarted = join(repository, ".git", "checkout-started");
    const checkoutRelease = join(repository, ".git", "checkout-release");
    await writeFile(
      hook,
      "#!/bin/sh\ntouch .git/checkout-started\nwhile [ ! -f .git/checkout-release ]; do :; done\n",
    );
    await chmod(hook, 0o755);
    const original = await registerExtension(session("switch-replaced", repository));
    const sibling = await registerExtension(session("switch-checkout-sibling", repository));
    const browser = await openSocket("/ws", { origin: "http://127.0.0.1:5173" });
    const frames = collectFrames(browser);

    browser.send(
      JSON.stringify({
        type: "switch_branch",
        requestId: "switch-replaced",
        sessionId: "switch-replaced",
        branch: "feature/target",
      }),
    );
    await waitUntil(() => access(checkoutStarted));
    browser.send(
      JSON.stringify({
        type: "switch_branch",
        requestId: "switch-overlap",
        sessionId: "switch-replaced",
        branch: "main",
      }),
    );
    browser.send(
      JSON.stringify({
        type: "session_command",
        requestId: "prompt-during-switch",
        sessionId: "switch-replaced",
        command: "prompt",
        text: "Do not run",
      }),
    );
    browser.send(
      JSON.stringify({
        type: "session_command",
        requestId: "sibling-prompt-during-switch",
        sessionId: "switch-checkout-sibling",
        command: "prompt",
        text: "Do not run",
      }),
    );
    await waitUntil(() => {
      expect(
        frames.some(
          (frame) =>
            frame.type === "command_result" &&
            frame.requestId === "switch-overlap" &&
            frame.outcome.status === "error" &&
            frame.outcome.error?.includes("already in progress") === true,
        ),
      ).toBe(true);
      expect(
        frames.some(
          (frame) =>
            frame.type === "command_result" &&
            frame.requestId === "prompt-during-switch" &&
            frame.outcome.status === "error" &&
            frame.outcome.error?.includes("switching branches") === true,
        ),
      ).toBe(true);
      expect(
        frames.some(
          (frame) =>
            frame.type === "command_result" &&
            frame.requestId === "sibling-prompt-during-switch" &&
            frame.outcome.status === "error" &&
            frame.outcome.error?.includes("switching branches") === true,
        ),
      ).toBe(true);
    });
    original.close();
    sibling.close();
    await once(original, "close");
    let replacement: WebSocket | undefined;
    try {
      replacement = await registerExtension(session("switch-replaced", replacementRepository));
    } finally {
      await writeFile(checkoutRelease, "");
    }

    await waitUntil(
      () =>
        expect(
          frames.some(
            (frame) =>
              frame.type === "command_result" &&
              frame.requestId === "switch-replaced" &&
              frame.outcome.status === "error" &&
              frame.outcome.error?.includes("no longer connected") === true,
          ),
        ).toBe(true),
      5_000,
    );
    await expect(currentBranch(repository)).resolves.toBe("feature/target");
    await expect(currentBranch(replacementRepository)).resolves.toBe("main");

    const replacementTopology = await fetch(
      `http://127.0.0.1:${daemonPort}/api/sessions/switch-replaced/branches`,
    );
    await expect(replacementTopology.json()).resolves.toMatchObject({ currentBranch: "main" });
    replacement?.close();
    browser.close();
  });
});
