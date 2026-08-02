import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionRoots, SessionCatalog } from "./session-catalog.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-remote-catalog-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("resolveSessionRoots", () => {
  it("includes the default agent and every local profile", async () => {
    const homeDirectory = await makeTemporaryDirectory();
    await mkdir(join(homeDirectory, ".omp", "profiles", "personal", "agent"), { recursive: true });
    await mkdir(join(homeDirectory, ".omp", "profiles", "work", "agent"), { recursive: true });

    await expect(resolveSessionRoots(homeDirectory)).resolves.toEqual([
      join(homeDirectory, ".omp", "agent", "sessions"),
      join(homeDirectory, ".omp", "profiles", "personal", "agent", "sessions"),
      join(homeDirectory, ".omp", "profiles", "work", "agent", "sessions"),
    ]);
  });
});

describe("SessionCatalog", () => {
  it("nests active subagents under their main session instead of listing them as sessions", async () => {
    const root = await makeTemporaryDirectory();
    const firstPath = join(root, "project-a", "first.jsonl");
    const nestedPath = join(root, "project-a", "first", "ResearchAgent.jsonl");
    const completedPath = join(root, "project-a", "first", "CompletedAgent.jsonl");
    await writeSession(firstPath, {
      id: "session-first",
      title: "Primary planning session",
      cwd: "/workspace/alpha",
      timestamp: "2026-07-27T10:00:00.000Z",
    });
    await writeSession(nestedPath, {
      id: "session-agent",
      title: "",
      cwd: "/workspace/alpha",
      timestamp: "2026-07-28T10:00:00.000Z",
    });
    await writeSession(
      completedPath,
      {
        id: "session-completed-agent",
        title: "",
        cwd: "/workspace/alpha",
        timestamp: "2026-07-28T09:00:00.000Z",
      },
      [
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "yield",
            details: { status: "success" },
            isError: false,
          },
        },
      ],
    );
    await writeFile(join(root, "project-a", "invalid.jsonl"), "not json\n", "utf8");
    await setModifiedTime(firstPath, "2026-07-27T11:00:00.000Z");
    await setModifiedTime(nestedPath, "2026-07-28T11:00:00.000Z");
    await setModifiedTime(completedPath, "2026-07-28T10:00:00.000Z");

    const catalog = new SessionCatalog([root]);
    const diff = await catalog.refresh();

    expect(diff.upserted.map((session) => session.id)).toEqual(["session-first"]);
    expect(diff.removed).toEqual([]);
    expect(catalog.list({ offset: 0, limit: 1, query: "" })).toEqual({
      sessions: [
        expect.objectContaining({
          id: "session-first",
          name: "Primary planning session",
          source: "history",
          status: "history",
          connected: false,
          sessionPath: firstPath,
          capabilities: ["resume"],
          messages: [],
          activeSubagents: [
            {
              id: "session-agent",
              name: "ResearchAgent",
              lastActivity: "2026-07-28T11:00:00.000Z",
            },
          ],
        }),
      ],
      total: 1,
      nextOffset: null,
    });
    expect(catalog.list({ offset: 0, limit: 20, query: "planning" }).sessions).toEqual([
      expect.objectContaining({ id: "session-first", name: "Primary planning session" }),
    ]);
    expect(catalog.list({ offset: 0, limit: 20, query: "RESEARCHAGENT" }).sessions).toEqual([
      expect.objectContaining({ id: "session-first" }),
    ]);
    expect(catalog.list({ offset: 20, limit: 20, query: "" })).toEqual({
      sessions: [],
      total: 1,
      nextOffset: null,
    });
  });

  it("lists sessions by creation time instead of file activity", async () => {
    const root = await makeTemporaryDirectory();
    const olderPath = join(root, "project-a", "older.jsonl");
    const newerPath = join(root, "project-a", "newer.jsonl");
    await writeSession(olderPath, {
      id: "older-session",
      title: "Older session",
      cwd: "/workspace/alpha",
      timestamp: "2026-07-28T10:00:00.000Z",
    });
    await writeSession(newerPath, {
      id: "newer-session",
      title: "Newer session",
      cwd: "/workspace/alpha",
      timestamp: "2026-07-28T11:00:00.000Z",
    });
    await setModifiedTime(olderPath, "2026-07-28T12:00:00.000Z");
    await setModifiedTime(newerPath, "2026-07-28T11:30:00.000Z");

    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    expect(
      catalog.list({ offset: 0, limit: 20, query: "" }).sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
      })),
    ).toEqual([
      { id: "newer-session", createdAt: "2026-07-28T11:00:00.000Z" },
      { id: "older-session", createdAt: "2026-07-28T10:00:00.000Z" },
    ]);
  });

  it("updates the main session when an active subagent exits", async () => {
    const root = await makeTemporaryDirectory();
    const mainPath = join(root, "project-a", "main.jsonl");
    const subagentPath = join(root, "project-a", "main", "Worker.jsonl");
    const mainHeader = {
      id: "session-main",
      title: "Main session",
      cwd: "/workspace/alpha",
      timestamp: "2026-07-28T10:00:00.000Z",
    };
    const subagentHeader = {
      id: "session-worker",
      title: "",
      cwd: "/workspace/alpha",
      timestamp: "2026-07-28T10:01:00.000Z",
    };
    await writeSession(mainPath, mainHeader);
    await writeSession(subagentPath, subagentHeader);

    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    await writeSession(subagentPath, subagentHeader, [
      { type: "custom", customType: "session_exit", data: { reason: "dispose" } },
    ]);
    const diff = await catalog.refresh();

    expect(diff.upserted).toEqual([expect.objectContaining({ id: "session-main", activeSubagents: [] })]);
    expect(diff.removed).toEqual([]);
    expect(catalog.list({ offset: 0, limit: 20, query: "" }).sessions[0]?.activeSubagents).toEqual([]);
  });

  it("uses the cwd leaf for generated session filenames without a title", async () => {
    const root = await makeTemporaryDirectory();
    const sessionPath = join(
      root,
      "project-a",
      "2026-07-28T22-03-11-256Z_019faac0-d218-7000-a8f9-d1c5875c00e4.jsonl",
    );
    await writeSession(sessionPath, {
      id: "019faac0-d218-7000-a8f9-d1c5875c00e4",
      title: "",
      cwd: "/workspace/alpha",
      timestamp: "2026-07-28T22:03:11.256Z",
    });

    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    expect(catalog.get("019faac0-d218-7000-a8f9-d1c5875c00e4")?.name).toBe("alpha");
  });

  it("only replaces exact generated stems and returns null without a cwd leaf", async () => {
    const root = await makeTemporaryDirectory();
    await writeSession(join(root, "project-a", "2026-07-28T23-00-00-000Z_session-root.jsonl"), {
      id: "session-root",
      title: "",
      cwd: "/",
      timestamp: "2026-07-28T23:00:00.000Z",
    });
    await writeSession(join(root, "project-a", "timestamp-like_session-invalid.jsonl"), {
      id: "session-invalid",
      title: "",
      cwd: "/workspace/alpha",
      timestamp: "not-a-timestamp",
    });
    await writeSession(join(root, "project-a", "missing-timestamp.jsonl"), {
      id: "session-missing",
      title: "",
      cwd: "/workspace/alpha",
    });

    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    expect(catalog.get("session-root")?.name).toBeNull();
    expect(catalog.get("session-invalid")?.name).toBe("timestamp-like_session-invalid");
    expect(catalog.get("session-missing")?.name).toBe("missing-timestamp");
  });

  it("prefers a non-empty mutable title over a different header title", async () => {
    const root = await makeTemporaryDirectory();
    await writeSession(join(root, "project-a", "custom-title.jsonl"), {
      id: "session-mutable-title",
      title: "Mutable title",
      headerTitle: "Older header title",
      cwd: "/workspace/alpha",
      timestamp: "2026-07-28T20:00:00.000Z",
    });

    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    expect(catalog.get("session-mutable-title")?.name).toBe("Mutable title");
  });

  it("uses the header title when the mutable title is empty", async () => {
    const root = await makeTemporaryDirectory();
    await writeSession(join(root, "project-a", "header-title.jsonl"), {
      id: "session-header-title",
      title: "",
      headerTitle: "Header title",
      cwd: "/workspace/alpha",
      timestamp: "2026-07-28T21:00:00.000Z",
    });

    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    expect(catalog.get("session-header-title")?.name).toBe("Header title");
  });

  it("preserves a custom filename stem despite a valid timestamp", async () => {
    const root = await makeTemporaryDirectory();
    await writeSession(join(root, "project-a", "2026-07-28T22-00-00-000Z_custom-session.jsonl"), {
      id: "session-custom",
      title: "",
      cwd: "/workspace/alpha",
      timestamp: "2026-07-28T22:00:00.000Z",
    });

    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    expect(catalog.get("session-custom")?.name).toBe("2026-07-28T22-00-00-000Z_custom-session");
  });

  it("derives an exact generated stem from a numeric timestamp", async () => {
    const root = await makeTemporaryDirectory();
    await writeSession(join(root, "project-a", "2026-07-28T22-03-11-256Z_session-numeric.jsonl"), {
      id: "session-numeric",
      title: "",
      cwd: "/workspace/alpha",
      timestamp: Date.UTC(2026, 6, 28, 22, 3, 11, 256),
    });

    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    expect(catalog.get("session-numeric")?.name).toBe("alpha");
  });

  it("reports changed and removed session files", async () => {
    const root = await makeTemporaryDirectory();
    const sessionPath = join(root, "project", "session.jsonl");
    await writeSession(sessionPath, {
      id: "session-1",
      title: "Original title",
      cwd: "/workspace/project",
      timestamp: "2026-07-28T10:00:00.000Z",
    });
    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    await writeSession(sessionPath, {
      id: "session-1",
      title: "Updated title",
      cwd: "/workspace/project",
      timestamp: "2026-07-28T10:00:00.000Z",
    });
    await setModifiedTime(sessionPath, "2026-07-28T12:00:00.000Z");
    const changed = await catalog.refresh();
    expect(changed.upserted).toEqual([expect.objectContaining({ id: "session-1", name: "Updated title" })]);
    expect(changed.removed).toEqual([]);

    await rm(sessionPath);
    const removed = await catalog.refresh();
    expect(removed.upserted).toEqual([]);
    expect(removed.removed).toEqual(["session-1"]);
    expect(catalog.fileChangeSources("session-1")).toBeUndefined();
  });

  it("uses a persisted edit result's canonical diff instead of its snapshot", async () => {
    const root = await makeTemporaryDirectory();
    const sessionPath = join(root, "project", "edit-session.jsonl");
    await writeSession(
      sessionPath,
      {
        id: "session-edit",
        title: "Edit session",
        cwd: "/workspace/project",
        timestamp: "2026-07-29T12:00:00.000Z",
      },
      [
        {
          type: "message",
          id: "edit-result-1",
          timestamp: "2026-07-29T12:01:00.000Z",
          message: {
            role: "toolResult",
            toolName: "edit",
            content: [{ type: "text", text: "*** Begin Patch\n*** End Patch" }],
            details: { diff: "-1|before\n+1|after" },
            isError: false,
          },
        },
      ],
    );
    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    await expect(catalog.transcript("session-edit")).resolves.toEqual([
      {
        id: "edit-result-1",
        role: "tool",
        text: "-1|before\n+1|after",
        timestamp: "2026-07-29T12:01:00.000Z",
        streaming: false,
        presentation: "diff",
        toolName: "edit",
      },
    ]);
  });

  it("preserves requested read selectors by correlating historical tool calls and results", async () => {
    const root = await makeTemporaryDirectory();
    const sessionPath = join(root, "project", "read-selectors.jsonl");
    const records = [":1-180", ":raw"].flatMap((selector, index) => {
      const toolCallId = `read-call-${index}`;
      const path = `/workspace/project/src/logs.d.ts${selector}`;
      return [
        {
          type: "message",
          id: `assistant-read-${index}`,
          timestamp: `2026-07-29T12:00:0${index}.000Z`,
          message: {
            role: "assistant",
            content: [{ type: "toolCall", toolCallId, name: "read", arguments: { path } }],
          },
        },
        {
          type: "message",
          id: `read-result-${index}`,
          timestamp: `2026-07-29T12:00:1${index}.000Z`,
          message: {
            role: "toolResult",
            toolCallId,
            toolName: "read",
            content: `result ${index}`,
            details: { meta: { source: { value: "/workspace/project/src/logs.d.ts" } } },
          },
        },
      ];
    });
    await writeSession(
      sessionPath,
      {
        id: "session-read-selectors",
        title: "Read selectors",
        cwd: "/workspace/project",
        timestamp: "2026-07-29T12:00:00.000Z",
      },
      records,
    );
    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    await expect(catalog.transcript("session-read-selectors")).resolves.toEqual([
      expect.objectContaining({
        id: "read-result-0",
        toolName: "read",
        readTarget: "/workspace/project/src/logs.d.ts:1-180",
      }),
      expect.objectContaining({
        id: "read-result-1",
        toolName: "read",
        readTarget: "/workspace/project/src/logs.d.ts:raw",
      }),
    ]);
  });

  it("derives id-less message identities from full text before display truncation", async () => {
    const root = await makeTemporaryDirectory();
    const sessionPath = join(root, "project", "long-idless-session.jsonl");
    const commonPrefix = "x".repeat(20_000);
    await writeSession(
      sessionPath,
      {
        id: "session-long-idless",
        title: "Long id-less messages",
        cwd: "/workspace/project",
        timestamp: "2026-07-29T12:00:00.000Z",
      },
      [
        {
          type: "message",
          timestamp: "2026-07-29T12:01:00.000Z",
          message: { role: "assistant", content: `${commonPrefix}a` },
        },
        {
          type: "message",
          timestamp: "2026-07-29T12:01:00.000Z",
          message: { role: "assistant", content: `${commonPrefix}b` },
        },
      ],
    );
    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    const messages = await catalog.transcript("session-long-idless");
    expect(messages.map(({ text }) => text)).toEqual([`${commonPrefix}…`, `${commonPrefix}…`]);
    expect(messages[0]?.id).not.toBe(messages[1]?.id);
  });

  it("streams the latest 200 meaningful transcript messages on demand", async () => {
    const root = await makeTemporaryDirectory();
    const sessionPath = join(root, "project", "long-session.jsonl");
    const records = Array.from({ length: 205 }, (_, index) => ({
      type: "message",
      id: `message-${index}`,
      timestamp: `2026-07-28T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Message ${index}` }],
      },
    }));
    records.splice(10, 0, {
      type: "message",
      id: "empty-tool-call",
      timestamp: "2026-07-28T10:00:10.500Z",
      message: { role: "assistant", content: [{ type: "toolCall", text: "" }] },
    });
    await writeSession(
      sessionPath,
      {
        id: "session-long",
        title: "Long session",
        cwd: "/workspace/project",
        timestamp: "2026-07-28T10:00:00.000Z",
      },
      records,
    );
    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    const messages = await catalog.transcript("session-long");

    expect(messages).toHaveLength(200);
    expect(messages[0]).toMatchObject({ id: "message-5", text: "Message 5", streaming: false });
    expect(messages.at(-1)).toMatchObject({ id: "message-204", text: "Message 204" });
  });
  it("selects one root and all descendants while excluding unrelated roots", async () => {
    const historyRoot = await makeTemporaryDirectory();
    const worktreeA = join(historyRoot, "worktree-a");
    const worktreeB = join(historyRoot, "worktree-b");
    const rootPath = join(historyRoot, "project", "root.jsonl");
    const childPath = join(historyRoot, "project", "root", "child.jsonl");
    const grandchildPath = join(historyRoot, "project", "root", "child", "grandchild.jsonl");
    const unrelatedPath = join(historyRoot, "project", "other.jsonl");
    await writeSession(rootPath, {
      id: "root-session",
      title: "Root",
      cwd: worktreeA,
      timestamp: "2026-08-01T10:00:00.000Z",
    });
    await writeSession(childPath, {
      id: "child-session",
      title: "Child",
      cwd: worktreeB,
      timestamp: "2026-08-01T10:01:00.000Z",
    });
    await writeSession(grandchildPath, {
      id: "grandchild-session",
      title: "Grandchild",
      cwd: worktreeB,
      timestamp: "2026-08-01T10:02:00.000Z",
    });
    await writeSession(unrelatedPath, {
      id: "other-session",
      title: "Other",
      cwd: worktreeA,
      timestamp: "2026-08-01T10:03:00.000Z",
    });
    const catalog = new SessionCatalog([historyRoot]);
    await catalog.refresh();

    expect(catalog.fileChangeSources("root-session")).toEqual({
      sources: [
        { sessionId: "root-session", root: worktreeA, sessionPath: rootPath },
        { sessionId: "child-session", root: worktreeB, sessionPath: childPath },
        { sessionId: "grandchild-session", root: worktreeB, sessionPath: grandchildPath },
      ],
      truncated: false,
    });
    expect(catalog.fileChangeSources("other-session")?.sources).toEqual([
      { sessionId: "other-session", root: worktreeA, sessionPath: unrelatedPath },
    ]);
    expect(catalog.fileChangeSources("missing-session")).toBeUndefined();
  });
});

interface SessionHeader {
  id: string;
  title: string;
  headerTitle?: string;
  cwd: string;
  timestamp?: string | number;
}

async function writeSession(path: string, header: SessionHeader, records: unknown[] = []): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = [
    JSON.stringify({ type: "title", v: 1, title: header.title, updatedAt: header.timestamp }),
    JSON.stringify({
      type: "session",
      version: 3,
      id: header.id,
      timestamp: header.timestamp,
      cwd: header.cwd,
      title: (header.headerTitle ?? header.title) || undefined,
    }),
    ...records.map((record) => JSON.stringify(record)),
  ];
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function setModifiedTime(path: string, timestamp: string): Promise<void> {
  const date = new Date(timestamp);
  await utimes(path, date, date);
}
