import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCatalog } from "./session-catalog.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-remote-catalog-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("SessionCatalog transcript and file changes", () => {
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

    const page = await catalog.transcript("session-long-idless");
    expect(page.messages.map(({ text }) => text)).toEqual([`${commonPrefix}…`, `${commonPrefix}…`]);
    expect(page.messages[0]?.id).not.toBe(page.messages[1]?.id);
    expect(page.status).toBe("complete");
    expect(page.olderCursor).toBeNull();
  });

  it("streams the latest 50 meaningful transcript messages on demand and paginates backwards", async () => {
    const root = await makeTemporaryDirectory();
    const sessionPath = join(root, "project", "long-session.jsonl");
    const records = Array.from({ length: 105 }, (_, index) => ({
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

    const initialPage = await catalog.transcript("session-long");
    expect(initialPage.messages).toHaveLength(50);
    expect(initialPage.status).toBe("available");
    expect(initialPage.olderCursor).toBeTruthy();
    expect(initialPage.messages[0]).toMatchObject({ id: "message-55", text: "Message 55", streaming: false });
    expect(initialPage.messages.at(-1)).toMatchObject({ id: "message-104", text: "Message 104" });

    const olderPage = await catalog.transcript("session-long", initialPage.olderCursor);
    expect(olderPage.messages).toHaveLength(50);
    expect(olderPage.status).toBe("available");
    expect(olderPage.olderCursor).toBeTruthy();
    expect(olderPage.messages[0]).toMatchObject({ id: "message-5", text: "Message 5" });
    expect(olderPage.messages.at(-1)).toMatchObject({ id: "message-54", text: "Message 54" });

    const terminalPage = await catalog.transcript("session-long", olderPage.olderCursor);
    expect(terminalPage.messages).toHaveLength(5);
    expect(terminalPage.status).toBe("complete");
    expect(terminalPage.olderCursor).toBeNull();
    expect(terminalPage.messages[0]).toMatchObject({ id: "message-0", text: "Message 0" });
    expect(terminalPage.messages.at(-1)).toMatchObject({ id: "message-4", text: "Message 4" });
  });

  it("hydrates thinking-only assistant messages from persisted session history", async () => {
    const root = await makeTemporaryDirectory();
    const sessionPath = join(root, "project", "thinking-session.jsonl");
    await writeSession(
      sessionPath,
      {
        id: "session-thinking",
        title: "Thinking session",
        cwd: "/workspace/project",
        timestamp: "2026-07-29T12:00:00.000Z",
      },
      [
        {
          type: "message",
          id: "message-thinking-1",
          timestamp: "2026-07-29T12:01:00.000Z",
          message: {
            role: "assistant",
            content: [{ type: "thinking", text: "Consider alternative approaches" }],
          },
        },
      ],
    );
    const catalog = new SessionCatalog([root]);
    await catalog.refresh();

    const page = await catalog.transcript("session-thinking");
    expect(page.messages).toEqual([
      expect.objectContaining({
        id: "message-thinking-1",
        role: "assistant",
        text: "Consider alternative approaches",
        streaming: false,
      }),
    ]);
    expect(page.status).toBe("complete");
    expect(page.olderCursor).toBeNull();
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
