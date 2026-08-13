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
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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
    await writeSession(
      nestedPath,
      {
        id: "session-agent",
        title: "",
        cwd: "/workspace/alpha",
        timestamp: "2026-07-28T10:00:00.000Z",
      },
      [{ type: "message", message: { role: "user", content: "assigned" } }],
    );
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
    expect(diff.upserted.map((session) => session.id)).toEqual(
      expect.arrayContaining(["session-first", "session-agent", "session-completed-agent"]),
    );
    expect(diff.upserted).toHaveLength(3);
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
  it("publishes canonical direct topology while keeping catalog pages root-only", async () => {
    const root = await makeTemporaryDirectory();
    const rootPath = join(root, "project", "root.jsonl");
    const childPath = join(root, "project", "root", "child.jsonl");
    const grandchildPath = join(root, "project", "root", "child", "grandchild.jsonl");
    await writeSession(rootPath, {
      id: "topology-root",
      title: "Root",
      cwd: "/workspace/project",
      timestamp: "2026-08-01T10:00:00.000Z",
    });
    await writeSession(
      childPath,
      {
        id: "topology-child",
        title: "Child",
        cwd: "/workspace/project",
        timestamp: "2026-08-01T10:01:00.000Z",
      },
      [{ type: "message", message: { role: "user", content: "assigned" } }],
    );
    await writeSession(
      grandchildPath,
      {
        id: "topology-grandchild",
        title: "Grandchild",
        cwd: "/workspace/project",
        timestamp: "2026-08-01T10:02:00.000Z",
      },
      [{ type: "message", message: { role: "user", content: "assigned" } }],
    );
    const catalog = new SessionCatalog([root]);
    const diff = await catalog.refresh();
    expect(diff.upserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "topology-root", parentSessionId: null }),
        expect.objectContaining({ id: "topology-child", parentSessionId: "topology-root" }),
        expect.objectContaining({ id: "topology-grandchild", parentSessionId: "topology-child" }),
      ]),
    );
    expect(catalog.list({ offset: 0, limit: 20, query: "" }).sessions.map((session) => session.id)).toEqual([
      "topology-root",
    ]);
    expect(catalog.get("topology-child")).toEqual(
      expect.objectContaining({ id: "topology-child", parentSessionId: "topology-root" }),
    );
    expect(catalog.get("topology-grandchild")).toEqual(
      expect.objectContaining({ id: "topology-grandchild", parentSessionId: "topology-child" }),
    );
  });
  it("retains proven child topology when an ancestor path disappears", async () => {
    const root = await makeTemporaryDirectory();
    const rootPath = join(root, "project", "root.jsonl");
    const childPath = join(root, "project", "root", "child.jsonl");
    const rootHeader = {
      id: "retained-root",
      title: "Root",
      cwd: "/workspace/project",
      timestamp: "2026-08-01T10:00:00.000Z",
    };
    const childHeader = {
      id: "retained-child",
      title: "Child",
      cwd: "/workspace/project",
      timestamp: "2026-08-01T10:01:00.000Z",
    };
    await writeSession(rootPath, rootHeader);
    await writeSession(childPath, childHeader);
    const catalog = new SessionCatalog([root]);
    await catalog.refresh();
    await rm(rootPath);
    await writeSession(childPath, childHeader, [{ type: "custom", customType: "session_exit" }]);
    const diff = await catalog.refresh();
    expect(catalog.get("retained-child")).toEqual(
      expect.objectContaining({ id: "retained-child", parentSessionId: "retained-root" }),
    );
    expect(catalog.list({ offset: 0, limit: 20, query: "" })).toMatchObject({
      sessions: [],
      total: 0,
      nextOffset: null,
    });
    expect(diff.upserted).toEqual([
      expect.objectContaining({ id: "retained-child", parentSessionId: "retained-root" }),
    ]);
  });
  it("retains a grandchild direct parent when the intermediate child path disappears", async () => {
    const root = await makeTemporaryDirectory();
    const rootPath = join(root, "project", "root.jsonl");
    const childPath = join(root, "project", "root", "child.jsonl");
    const grandchildPath = join(root, "project", "root", "child", "grandchild.jsonl");
    await writeSession(rootPath, {
      id: "loss-root",
      title: "Root",
      cwd: "/workspace/project",
      timestamp: "2026-08-01T10:00:00.000Z",
    });
    await writeSession(
      childPath,
      {
        id: "loss-child",
        title: "Child",
        cwd: "/workspace/project",
        timestamp: "2026-08-01T10:01:00.000Z",
      },
      [{ type: "message", message: { role: "user", content: "assigned" } }],
    );
    await writeSession(
      grandchildPath,
      {
        id: "loss-grandchild",
        title: "Grandchild",
        cwd: "/workspace/project",
        timestamp: "2026-08-01T10:02:00.000Z",
      },
      [{ type: "message", message: { role: "user", content: "assigned" } }],
    );
    const catalog = new SessionCatalog([root]);
    await catalog.refresh();
    await rm(childPath);
    await setModifiedTime(grandchildPath, "2026-08-01T10:03:00.000Z");
    const diff = await catalog.refresh();
    expect(catalog.get("loss-grandchild")).toEqual(
      expect.objectContaining({ id: "loss-grandchild", parentSessionId: "loss-child" }),
    );
    expect(diff.upserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "loss-root", activeSubagents: [] }),
        expect.objectContaining({ id: "loss-grandchild", parentSessionId: "loss-child" }),
      ]),
    );
    expect(diff.upserted).toHaveLength(2);
    expect(catalog.list({ offset: 0, limit: 20, query: "" }).sessions).toEqual([
      expect.objectContaining({ id: "loss-root", parentSessionId: null }),
    ]);
  });
  it("leaves a first-observed nested path unknown when its immediate parent is absent", async () => {
    const root = await makeTemporaryDirectory();
    const rootPath = join(root, "project", "root.jsonl");
    const grandchildPath = join(root, "project", "root", "missing", "grandchild.jsonl");
    await writeSession(rootPath, {
      id: "unknown-root",
      title: "Root",
      cwd: "/workspace/project",
      timestamp: "2026-08-01T10:00:00.000Z",
    });
    await writeSession(grandchildPath, {
      id: "unknown-grandchild",
      title: "Grandchild",
      cwd: "/workspace/project",
      timestamp: "2026-08-01T10:01:00.000Z",
    });
    const catalog = new SessionCatalog([root]);
    const diff = await catalog.refresh();
    expect(diff.upserted).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "unknown-grandchild" })]),
    );
    expect(catalog.get("unknown-grandchild")).not.toHaveProperty("parentSessionId");
    expect(catalog.list({ offset: 0, limit: 20, query: "" }).sessions.map((session) => session.id)).toEqual([
      "unknown-root",
    ]);
  });
  it("binds duplicate IDs to the latest catalog entry and its topology", async () => {
    const root = await makeTemporaryDirectory();
    const rootPath = join(root, "project", "root.jsonl");
    const nestedPath = join(root, "project", "root", "duplicate.jsonl");
    const latestPath = join(root, "other", "duplicate.jsonl");
    await writeSession(rootPath, {
      id: "duplicate-root",
      title: "Root",
      cwd: "/workspace/project",
      timestamp: "2026-08-01T10:00:00.000Z",
    });
    await writeSession(nestedPath, {
      id: "duplicate",
      title: "Nested duplicate",
      cwd: "/workspace/project",
      timestamp: "2026-08-01T10:01:00.000Z",
    });
    await writeSession(latestPath, {
      id: "duplicate",
      title: "Latest duplicate",
      cwd: "/workspace/other",
      timestamp: "2026-08-01T10:02:00.000Z",
    });
    await setModifiedTime(nestedPath, "2026-08-01T10:01:00.000Z");
    await setModifiedTime(latestPath, "2026-08-01T10:03:00.000Z");
    const catalog = new SessionCatalog([root]);
    await catalog.refresh();
    expect(catalog.get("duplicate")).toEqual(
      expect.objectContaining({
        name: "Latest duplicate",
        parentSessionId: null,
        sessionPath: latestPath,
      }),
    );
    expect(catalog.list({ offset: 0, limit: 20, query: "" }).sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining(["duplicate-root", "duplicate"]),
    );
    expect(catalog.list({ offset: 0, limit: 20, query: "" }).total).toBe(2);
  });
  it("retains direct-parent evidence per path when the selected duplicate changes", async () => {
    const root = await makeTemporaryDirectory();
    const firstRootPath = join(root, "first", "root.jsonl");
    const firstParentPath = join(root, "first", "root", "parent.jsonl");
    const firstDuplicatePath = join(root, "first", "root", "parent", "duplicate.jsonl");
    const secondRootPath = join(root, "second", "root.jsonl");
    const secondParentPath = join(root, "second", "root", "parent.jsonl");
    const secondDuplicatePath = join(root, "second", "root", "parent", "duplicate.jsonl");
    await writeSession(firstRootPath, {
      id: "first-root",
      title: "First root",
      cwd: "/workspace/first",
      timestamp: "2026-08-01T10:00:00.000Z",
    });
    await writeSession(firstParentPath, {
      id: "first-parent",
      title: "First parent",
      cwd: "/workspace/first",
      timestamp: "2026-08-01T10:01:00.000Z",
    });
    await writeSession(firstDuplicatePath, {
      id: "changing-duplicate",
      title: "First duplicate",
      cwd: "/workspace/first",
      timestamp: "2026-08-01T10:02:00.000Z",
    });
    await writeSession(secondRootPath, {
      id: "second-root",
      title: "Second root",
      cwd: "/workspace/second",
      timestamp: "2026-08-01T10:00:00.000Z",
    });
    await writeSession(secondParentPath, {
      id: "second-parent",
      title: "Second parent",
      cwd: "/workspace/second",
      timestamp: "2026-08-01T10:01:00.000Z",
    });
    await writeSession(secondDuplicatePath, {
      id: "changing-duplicate",
      title: "Second duplicate",
      cwd: "/workspace/second",
      timestamp: "2026-08-01T10:03:00.000Z",
    });
    await setModifiedTime(firstDuplicatePath, "2026-08-01T10:02:00.000Z");
    await setModifiedTime(secondDuplicatePath, "2026-08-01T10:03:00.000Z");
    const catalog = new SessionCatalog([root]);
    await catalog.refresh();
    expect(catalog.get("changing-duplicate")).toEqual(
      expect.objectContaining({
        name: "Second duplicate",
        parentSessionId: "second-parent",
        sessionPath: secondDuplicatePath,
      }),
    );
    await rm(firstParentPath);
    await writeSession(firstDuplicatePath, {
      id: "changing-duplicate",
      title: "First duplicate refreshed",
      cwd: "/workspace/first",
      timestamp: "2026-08-01T10:04:00.000Z",
    });
    await setModifiedTime(firstDuplicatePath, "2026-08-01T10:04:00.000Z");
    await catalog.refresh();
    expect(catalog.get("changing-duplicate")).toEqual(
      expect.objectContaining({
        name: "First duplicate refreshed",
        parentSessionId: "first-parent",
        sessionPath: firstDuplicatePath,
      }),
    );
  });
  it("loads exact persisted usage only for the requested root and descendants", async () => {
    const root = await makeTemporaryDirectory();
    const rootPath = join(root, "project", "root.jsonl");
    const childPath = join(root, "project", "root", "child.jsonl");
    const grandchildPath = join(root, "project", "root", "child", "grandchild.jsonl");
    const unrelatedPath = join(root, "other-project", "unrelated.jsonl");
    await writeSession(
      rootPath,
      { id: "root", title: "Root", cwd: "/workspace/root", timestamp: "2026-08-01T10:00:00.000Z" },
      [assistantUsage(1), assistantUsage(0.25)],
    );
    await writeSession(
      childPath,
      { id: "child", title: "Child", cwd: "/workspace/root", timestamp: "2026-08-01T10:01:00.000Z" },
      [assistantUsage(0.5)],
    );
    await writeSession(
      grandchildPath,
      {
        id: "grandchild",
        title: "Grandchild",
        cwd: "/workspace/root",
        timestamp: "2026-08-01T10:02:00.000Z",
      },
      [assistantUsage(0.2), { type: "custom", customType: "session_exit" }],
    );
    await writeSession(
      unrelatedPath,
      {
        id: "unrelated",
        title: "Unrelated",
        cwd: "/workspace/unrelated",
        timestamp: "2026-08-01T10:03:00.000Z",
      },
      [assistantUsage(9)],
    );
    let costReads = 0;
    const catalog = new SessionCatalog([root], {
      beforeCostRead: async () => {
        costReads += 1;
      },
    });
    const initial = await catalog.refresh();
    expect(initial.upserted[0]?.costSummary).toBeUndefined();
    expect(catalog.get("root")?.costSummary).toBeUndefined();
    expect(costReads).toBe(0);
    await expect(catalog.costSummary("root")).resolves.toEqual({
      totalUsd: 1.95,
      partial: false,
      agents: [
        { sessionId: "root", name: "Root", parentSessionId: null, totalUsd: 1.25, available: true },
        { sessionId: "child", name: "Child", parentSessionId: "root", totalUsd: 0.5, available: true },
        {
          sessionId: "grandchild",
          name: "Grandchild",
          parentSessionId: "child",
          totalUsd: 0.2,
          available: true,
        },
      ],
    });
    expect(costReads).toBe(3);
    await writeFile(rootPath, `${JSON.stringify(assistantUsage(0.05))}\n`, { flag: "a" });
    await setModifiedTime(rootPath, "2026-08-01T11:00:00.000Z");
    const updated = await catalog.refresh();
    expect(updated.upserted[0]?.costSummary).toBeUndefined();
    expect(catalog.get("root")?.costSummary).toBeUndefined();
    await expect(catalog.costSummary("root")).resolves.toMatchObject({ totalUsd: 2 });
    expect(costReads).toBe(4);
  });
  it("isolates failed requested roots and keeps exact summaries for healthy roots", async () => {
    const history = await makeTemporaryDirectory();
    const healthyPath = join(history, "healthy", "session.jsonl");
    const failedPath = join(history, "failed", "session.jsonl");
    await writeSession(
      healthyPath,
      {
        id: "healthy",
        title: "Healthy",
        cwd: "/workspace/healthy",
        timestamp: "2026-08-01T10:00:00.000Z",
      },
      [assistantUsage(0.75)],
    );
    await writeSession(
      failedPath,
      {
        id: "failed",
        title: "Failed",
        cwd: "/workspace/failed",
        timestamp: "2026-08-01T10:01:00.000Z",
      },
      [assistantUsage("not-a-number")],
    );
    const catalog = new SessionCatalog([history]);
    await catalog.refresh();
    await expect(catalog.costSummary("healthy")).resolves.toMatchObject({ totalUsd: 0.75 });
    await expect(catalog.costSummary("failed")).resolves.toBeUndefined();
  });
  it("deduplicates concurrent cost reads for the selected session", async () => {
    const history = await makeTemporaryDirectory();
    const sessionPath = join(history, "project", "session.jsonl");
    await writeSession(
      sessionPath,
      {
        id: "session-single-flight",
        title: "Single flight",
        cwd: "/workspace/project",
        timestamp: "2026-08-01T10:00:00.000Z",
      },
      [assistantUsage(1)],
    );
    const costReadGate = deferred<void>();
    let costReads = 0;
    const catalog = new SessionCatalog([history], {
      beforeCostRead: async () => {
        costReads += 1;
        await costReadGate.promise;
      },
    });
    await catalog.refresh();
    const first = catalog.costSummary("session-single-flight");
    const second = catalog.costSummary("session-single-flight");
    await Promise.resolve();
    expect(costReads).toBe(1);
    costReadGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        totalUsd: 1,
        partial: false,
        agents: [
          {
            sessionId: "session-single-flight",
            name: "Single flight",
            parentSessionId: null,
            totalUsd: 1,
            available: true,
          },
        ],
      },
      {
        totalUsd: 1,
        partial: false,
        agents: [
          {
            sessionId: "session-single-flight",
            name: "Single flight",
            parentSessionId: null,
            totalUsd: 1,
            available: true,
          },
        ],
      },
    ]);
  });
  it("does not return a cost summary for a stale fingerprint", async () => {
    const history = await makeTemporaryDirectory();
    const sessionPath = join(history, "project", "session.jsonl");
    await writeSession(
      sessionPath,
      {
        id: "session-stale-cost",
        title: "Stale cost",
        cwd: "/workspace/project",
        timestamp: "2026-08-01T10:00:00.000Z",
      },
      [assistantUsage(1)],
    );
    const costReadGate = deferred<void>();
    const catalog = new SessionCatalog([history], {
      beforeCostRead: () => costReadGate.promise,
    });
    await catalog.refresh();
    const staleCost = catalog.costSummary("session-stale-cost");
    await writeSession(
      sessionPath,
      {
        id: "session-stale-cost",
        title: "Stale cost",
        cwd: "/workspace/project",
        timestamp: "2026-08-01T10:00:00.000Z",
      },
      [assistantUsage(2)],
    );
    await setModifiedTime(sessionPath, "2026-08-01T11:00:00.000Z");
    await catalog.refresh();
    costReadGate.resolve();
    await expect(staleCost).resolves.toBeUndefined();
    await expect(catalog.costSummary("session-stale-cost")).resolves.toMatchObject({ totalUsd: 2 });
  });
  it("does not mark a summary exact when a descendant appears during loading", async () => {
    const history = await makeTemporaryDirectory();
    const rootPath = join(history, "project", "root.jsonl");
    const childPath = join(history, "project", "root", "child.jsonl");
    await writeSession(
      rootPath,
      {
        id: "root-growing-tree",
        title: "Growing tree",
        cwd: "/workspace/project",
        timestamp: "2026-08-01T10:00:00.000Z",
      },
      [assistantUsage(1)],
    );
    const costReadGate = deferred<void>();
    const catalog = new SessionCatalog([history], {
      beforeCostRead: () => costReadGate.promise,
    });
    await catalog.refresh();
    const staleCost = catalog.costSummary("root-growing-tree");
    await writeSession(
      childPath,
      {
        id: "new-child",
        title: "New child",
        cwd: "/workspace/project",
        timestamp: "2026-08-01T10:01:00.000Z",
      },
      [assistantUsage(0.5)],
    );
    await catalog.refresh();
    costReadGate.resolve();
    await expect(staleCost).resolves.toBeUndefined();
    await expect(catalog.costSummary("root-growing-tree")).resolves.toMatchObject({
      totalUsd: 1.5,
      partial: false,
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
  it("classifies child lifecycles fail-safe and updates the parent", async () => {
    const root = await makeTemporaryDirectory();
    const timestamp = "2026-07-28T10:00:00.000Z";
    const childPath = (id: string) => join(root, "project", "parent", `${id}.jsonl`);
    const header = (id: string) => ({ id, title: id, cwd: "/workspace/project", timestamp });
    const message = (
      role: string,
      data: Record<string, unknown> = {},
      envelope: Record<string, unknown> = {},
    ) => ({ type: "message", message: { role, ...data }, ...envelope });
    const init = { type: "session_init", task: "start" };
    const assignment = message("user", { content: "assign" });
    const assigned = (...tail: unknown[]) => [init, assignment, ...tail];
    const aborted = message("assistant", { stopReason: "aborted" });
    const syntheticSteering = message("user", {}, { attribution: "agent", steering: true });
    const states = {
      assigned: assigned(),
      agentAssigned: [init, message("user", { content: "assign" }, { attribution: "agent" })],
      yielded: assigned(message("toolResult", { toolName: "yield", details: { data: {} } })),
      exited: assigned({ type: "custom", customType: "session_exit" }),
      aborted: assigned(aborted),
      exitSteeredAborted: assigned(
        { type: "custom", customType: "session_exit" },
        syntheticSteering,
        aborted,
      ),
      abortSteered: assigned(aborted, syntheticSteering),
      resumed: assigned(aborted, message("user", { content: "resume" })),
    };
    await writeSession(join(root, "project", "parent.jsonl"), header("parent"));
    await Promise.all(
      Object.entries(states).map(([id, records]) => writeSession(childPath(id), header(id), records)),
    );
    const writeRaw = (id: string, records: string[], complete = true) =>
      writeRawSession(childPath(id), header(id), records, complete);
    const large = (size: number) =>
      JSON.stringify({ type: "custom", customType: "large", data: "x".repeat(size) });
    await Promise.all([
      writeRaw("partial", ['{"type":"session_init","task":"start"'], false),
      writeRaw("malformed", ['{"type":"session_init","task":"start"}', "not-json"]),
      writeRaw("large-malformed", [
        JSON.stringify(init),
        "x".repeat(20_000),
        JSON.stringify(states.yielded[2]),
      ]),
      writeRaw("unassigned", [JSON.stringify(init)]),
      writeRaw("large-unassigned", [large(20_000)]),
      writeRaw("large-parked", [
        JSON.stringify(init),
        JSON.stringify(assignment),
        large(140_000),
        JSON.stringify(states.exited[2]),
      ]),
      writeRaw("oversized", [large(140_000)]),
    ]);
    const catalog = new SessionCatalog([root]);
    await catalog.refresh();
    const activeIds = catalog.get("parent")?.activeSubagents?.map(({ id }) => id);
    expect(activeIds?.sort().join()).toBe(
      "agentAssigned,assigned,large-malformed,malformed,oversized,partial,resumed",
    );
    expect(catalog.fileChangeSources("parent")?.sources.map(({ sessionId }) => sessionId)).toEqual(
      expect.arrayContaining(["unassigned", "large-unassigned", "partial", "malformed", "large-malformed"]),
    );
    await writeSession(childPath("assigned"), header("assigned"), states.exited);
    const second = await catalog.refresh();
    const updatedParent = second.upserted.find(({ id }) => id === "parent");
    expect(updatedParent).toBeDefined();
    expect(updatedParent?.activeSubagents.map(({ id }) => id)).not.toContain("assigned");
    expect(second.upserted).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "assigned", parentSessionId: "parent" })]),
    );
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
});
function assistantUsage(total: unknown): Record<string, unknown> {
  return {
    type: "message",
    message: {
      role: "assistant",
      usage: { cost: { total } },
    },
  };
}
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
async function writeRawSession(
  path: string,
  header: SessionHeader,
  records: string[],
  trailingNewline = true,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      JSON.stringify({ type: "title", v: 1, title: header.title, updatedAt: header.timestamp }),
      JSON.stringify({
        type: "session",
        version: 3,
        id: header.id,
        timestamp: header.timestamp,
        cwd: header.cwd,
      }),
      ...records,
    ].join("\n") + (trailingNewline ? "\n" : ""),
    "utf8",
  );
}
async function setModifiedTime(path: string, timestamp: string): Promise<void> {
  const date = new Date(timestamp);
  await utimes(path, date, date);
}
