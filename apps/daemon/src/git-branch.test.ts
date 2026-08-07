import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertBranchSwitchSessionState,
  loadGitBranchTopology,
  listLocalGitBranches,
  resolveGitBranch,
  switchGitBranch,
} from "./git-branch.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function commit(repository: string, message: string, content: string): Promise<void> {
  await writeFile(join(repository, "tracked.txt"), content);
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", message], { cwd: repository });
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "omp-remote-git-topology-"));
  temporaryDirectories.push(repository);
  await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repository });
  await commit(repository, "main", "main\n");
  return repository;
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function createTopologyRepository(): Promise<string> {
  const repository = await createRepository();
  await execFileAsync("git", ["switch", "-c", "feature/parent"], { cwd: repository });
  await commit(repository, "parent", "parent\n");
  await execFileAsync("git", ["switch", "-c", "feature/child"], { cwd: repository });
  await commit(repository, "child", "child\n");
  await execFileAsync("git", ["switch", "main"], { cwd: repository });
  await execFileAsync("git", ["switch", "-c", "feature/sibling"], { cwd: repository });
  await commit(repository, "sibling", "sibling\n");
  await execFileAsync("git", ["switch", "feature/child"], { cwd: repository });
  return repository;
}

describe("resolveGitBranch", () => {
  it("returns the checked out symbolic branch", async () => {
    const repository = await mkdtemp(join(tmpdir(), "omp-remote-git-branch-"));
    temporaryDirectories.push(repository);
    await execFileAsync("git", ["init", "--initial-branch", "feature/session-header"], { cwd: repository });

    await expect(resolveGitBranch(repository)).resolves.toBe("feature/session-header");
  });

  it("returns null outside a Git worktree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-remote-no-git-branch-"));
    temporaryDirectories.push(directory);

    await expect(resolveGitBranch(directory)).resolves.toBeNull();
  });
});

describe("assertBranchSwitchSessionState", () => {
  it.each([
    { source: "rpc" as const, status: "idle" as const },
    { source: "rpc" as const, status: "waiting" as const },
    { source: "extension" as const, status: "idle" as const },
    { source: "extension" as const, status: "waiting" as const },
  ])("admits connected $source $status sessions", (session) => {
    expect(() => assertBranchSwitchSessionState({ connected: true, ...session })).not.toThrow();
  });

  it.each([
    {
      connected: true,
      source: "rpc" as const,
      status: "running" as const,
      error: "Cannot switch branches while the session is running.",
    },
    {
      connected: false,
      source: "extension" as const,
      status: "idle" as const,
      error: "This OMP session is no longer connected.",
    },
    {
      connected: true,
      source: "rpc" as const,
      status: "history" as const,
      error: "This OMP session is no longer connected.",
    },
    {
      connected: true,
      source: "history" as const,
      status: "idle" as const,
      error: "This OMP session is no longer connected.",
    },
  ])("rejects $source $status session state", (session) => {
    expect(() => assertBranchSwitchSessionState(session)).toThrow(session.error);
  });
});

describe("loadGitBranchTopology", () => {
  it("returns every local branch once with deterministic order and Git ancestry", async () => {
    const repository = await createTopologyRepository();

    const topology = await loadGitBranchTopology(repository, "session-1", async () => null);

    expect(topology?.sessionId).toBe("session-1");
    expect(topology?.currentBranch).toBe("feature/child");
    expect(topology?.branches.map(({ name }) => name)).toEqual([
      "feature/child",
      "feature/parent",
      "feature/sibling",
      "main",
    ]);
    expect(topology?.branches.find(({ name }) => name === "feature/parent")?.parent).toBe("main");
    expect(topology?.branches.find(({ name }) => name === "feature/child")?.parent).toBe("feature/parent");
  });

  it("retries when the current branch changes while topology is loading", async () => {
    const repository = await createTopologyRepository();
    let switched = false;

    const topology = await loadGitBranchTopology(repository, "session-1", async () => {
      if (!switched) {
        switched = true;
        await execFileAsync("git", ["switch", "main"], { cwd: repository });
      }
      return null;
    });

    expect(topology?.currentBranch).toBe("main");
  });

  it("returns branch topology larger than the default execFile buffer", async () => {
    const repository = await createRepository();
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository });
    const refsDirectory = join(repository, ".git", "refs", "heads", "generated");
    await mkdir(refsDirectory, { recursive: true });
    const branchNames = Array.from(
      { length: 300 },
      (_, index) => `generated/${String(index).padStart(3, "0")}-${"x".repeat(220)}`,
    );
    await Promise.all(
      branchNames.map((name) =>
        writeFile(join(repository, ".git", "refs", "heads", name), `${stdout.trim()}\n`),
      ),
    );

    const topology = await loadGitBranchTopology(repository, "session-1", async () => null);

    expect(topology?.branches).toHaveLength(branchNames.length + 1);
    expect(topology?.branches.map(({ name }) => name)).toEqual([...branchNames, "main"].sort());
  });

  it("prefers a valid complete Graphite order", async () => {
    const repository = await createTopologyRepository();
    const graphiteOrder = ["main", "feature/sibling", "feature/parent", "feature/child"] as const;

    const topology = await loadGitBranchTopology(repository, "session-1", async (_cwd, branches) => {
      expect(branches).toEqual(["feature/child", "feature/parent", "feature/sibling", "main"]);
      return graphiteOrder;
    });

    expect(topology?.branches.map(({ name }) => name)).toEqual(graphiteOrder);
  });

  it("parses a successful Graphite short-log order", async () => {
    const repository = await createTopologyRepository();
    const graphite = join(repository, "gt");
    await writeFile(
      graphite,
      "#!/bin/sh\nprintf '◯ main\\n◯ feature/sibling\\n◉ feature/parent\\n◉ feature/child\\n'\n",
    );
    await chmod(graphite, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${repository}${delimiter}${originalPath ?? ""}`;

    try {
      const topology = await loadGitBranchTopology(repository, "session-1");
      expect(topology?.branches.map(({ name }) => name)).toEqual([
        "main",
        "feature/sibling",
        "feature/parent",
        "feature/child",
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it.each([
    { label: "incomplete", order: ["main", "feature/parent"] },
    { label: "duplicate", order: ["main", "main", "feature/parent", "feature/child"] },
    { label: "unknown", order: ["main", "feature/parent", "feature/child", "missing"] },
  ])("falls back to complete Git ordering for $label Graphite output", async ({ order }) => {
    const repository = await createTopologyRepository();

    const topology = await loadGitBranchTopology(repository, "session-1", async () => order);

    expect(topology?.branches.map(({ name }) => name)).toEqual([
      "feature/child",
      "feature/parent",
      "feature/sibling",
      "main",
    ]);
    expect(topology?.branches.find(({ name }) => name === "feature/child")?.parent).toBe("feature/parent");
  });

  it("projects same-tip and merge ancestors deterministically", async () => {
    const sameTipRepository = await createTopologyRepository();
    await execFileAsync("git", ["branch", "feature/child-alias"], { cwd: sameTipRepository });
    const sameTipTopology = await loadGitBranchTopology(sameTipRepository, "session-1", async () => null);
    expect(sameTipTopology?.branches.find(({ name }) => name === "feature/child")?.parent).toBe(
      "feature/parent",
    );
    expect(sameTipTopology?.branches.find(({ name }) => name === "feature/child-alias")?.parent).toBe(
      "feature/parent",
    );

    const mergeRepository = await createRepository();
    await execFileAsync("git", ["switch", "-c", "feature/left"], { cwd: mergeRepository });
    await writeFile(join(mergeRepository, "left.txt"), "left\n");
    await execFileAsync("git", ["add", "left.txt"], { cwd: mergeRepository });
    await execFileAsync("git", ["commit", "-m", "left"], { cwd: mergeRepository });
    await execFileAsync("git", ["branch", "feature/left-tip"], { cwd: mergeRepository });
    await execFileAsync("git", ["switch", "main"], { cwd: mergeRepository });
    await execFileAsync("git", ["switch", "-c", "feature/right"], { cwd: mergeRepository });
    await writeFile(join(mergeRepository, "right.txt"), "right\n");
    await execFileAsync("git", ["add", "right.txt"], { cwd: mergeRepository });
    await execFileAsync("git", ["commit", "-m", "right"], { cwd: mergeRepository });
    await execFileAsync("git", ["switch", "feature/left-tip"], { cwd: mergeRepository });
    await execFileAsync("git", ["switch", "-c", "feature/merge"], { cwd: mergeRepository });
    await execFileAsync("git", ["merge", "--no-ff", "feature/right", "-m", "merge"], {
      cwd: mergeRepository,
    });

    const mergeTopology = await loadGitBranchTopology(mergeRepository, "session-1", async () => null);
    expect(mergeTopology?.branches.find(({ name }) => name === "feature/merge")?.parent).toBe("feature/left");
  });

  it("rejects commit graph probe failures instead of returning root-only topology", async () => {
    const repository = await createTopologyRepository();
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository });
    const objectName = stdout.trim();
    const objectPath = join(repository, ".git", "objects", objectName.slice(0, 2), objectName.slice(2));

    await expect(
      loadGitBranchTopology(repository, "session-1", async () => {
        await rename(objectPath, `${objectPath}.missing`);
        return null;
      }),
    ).rejects.toThrow();
  });

  it("returns null for detached repositories and rejects branch enumeration failures", async () => {
    const repository = await createRepository();
    await execFileAsync("git", ["checkout", "--detach"], { cwd: repository });
    expect(await loadGitBranchTopology(repository, "session-1")).toBeNull();

    const directory = await mkdtemp(join(tmpdir(), "omp-remote-no-git-topology-"));
    temporaryDirectories.push(directory);
    expect(await loadGitBranchTopology(directory, "session-1")).toBeNull();
    await expect(listLocalGitBranches(directory)).rejects.toThrow();
  });
});

describe("switchGitBranch", () => {
  it("switches existing branches without accepting option-like input", async () => {
    const repository = await createRepository();
    await execFileAsync("git", ["switch", "-c", "feature/target"], { cwd: repository });
    await execFileAsync("git", ["switch", "main"], { cwd: repository });

    await switchGitBranch(repository, "feature/target");
    await expect(resolveGitBranch(repository)).resolves.toBe("feature/target");
    await expect(switchGitBranch(repository, "--detach")).rejects.toThrow("not a local branch");
    await expect(listLocalGitBranches(repository)).resolves.toEqual(["feature/target", "main"]);
  });

  it("allows checkout hooks to run longer than branch discovery probes", async () => {
    const repository = await createRepository();
    await execFileAsync("git", ["switch", "-c", "feature/target"], { cwd: repository });
    await execFileAsync("git", ["switch", "main"], { cwd: repository });
    const hook = join(repository, ".git", "hooks", "post-checkout");
    await writeFile(hook, "#!/bin/sh\nsleep 3\n");
    await chmod(hook, 0o755);

    await switchGitBranch(repository, "feature/target");

    await expect(resolveGitBranch(repository)).resolves.toBe("feature/target");
  }, 10_000);

  it("preserves a dirty worktree when Git rejects a conflicting switch", async () => {
    const repository = await createRepository();
    await execFileAsync("git", ["switch", "-c", "feature/target"], { cwd: repository });
    await commit(repository, "target", "target\n");
    await execFileAsync("git", ["switch", "main"], { cwd: repository });
    await writeFile(join(repository, "tracked.txt"), "uncommitted\n");

    await expect(switchGitBranch(repository, "feature/target")).rejects.toThrow(/local changes|overwritten/u);
    await expect(resolveGitBranch(repository)).resolves.toBe("main");
    await expect(execFileAsync("git", ["diff", "--quiet"], { cwd: repository })).rejects.toBeDefined();
  });
});
