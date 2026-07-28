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
  it("indexes every nested session and supports bounded search pages", async () => {
    const root = await makeTemporaryDirectory();
    const firstPath = join(root, "project-a", "first.jsonl");
    const nestedPath = join(root, "project-a", "first", "ResearchAgent.jsonl");
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
    await writeFile(join(root, "project-a", "invalid.jsonl"), "not json\n", "utf8");
    await setModifiedTime(firstPath, "2026-07-27T11:00:00.000Z");
    await setModifiedTime(nestedPath, "2026-07-28T11:00:00.000Z");

    const catalog = new SessionCatalog([root]);
    const diff = await catalog.refresh();

    expect(diff.upserted.map((session) => session.id).sort()).toEqual(["session-agent", "session-first"]);
    expect(diff.removed).toEqual([]);
    expect(catalog.list({ offset: 0, limit: 1, query: "" })).toEqual({
      sessions: [
        expect.objectContaining({
          id: "session-agent",
          name: "ResearchAgent",
          source: "history",
          status: "history",
          connected: false,
          sessionPath: nestedPath,
          capabilities: ["resume"],
          messages: [],
        }),
      ],
      total: 2,
      nextOffset: 1,
    });
    expect(catalog.list({ offset: 0, limit: 20, query: "planning" }).sessions).toEqual([
      expect.objectContaining({ id: "session-first", name: "Primary planning session" }),
    ]);
    expect(catalog.list({ offset: 0, limit: 20, query: "SESSION-AGENT" }).sessions).toHaveLength(1);
    expect(catalog.list({ offset: 20, limit: 20, query: "" })).toEqual({
      sessions: [],
      total: 2,
      nextOffset: null,
    });
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
  cwd: string;
  timestamp: string;
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
      title: header.title || undefined,
    }),
    ...records.map((record) => JSON.stringify(record)),
  ];
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function setModifiedTime(path: string, timestamp: string): Promise<void> {
  const date = new Date(timestamp);
  await utimes(path, date, date);
}
