import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitBranch } from "./git-branch.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

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
