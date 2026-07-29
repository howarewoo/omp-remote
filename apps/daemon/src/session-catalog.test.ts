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
