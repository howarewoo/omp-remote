import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectWorkingTreeDiff, countPatchLines, parseGitStatus } from "./git-working-tree.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function createRepository() {
  const repository = await mkdtemp(join(tmpdir(), "omp-remote-diff-"));
  temporaryDirectories.push(repository);
  await git(repository, ["init", "--initial-branch", "main"]);
  await writeFile(join(repository, "modified.txt"), "before\n");
  await writeFile(join(repository, "deleted.txt"), "removed\n");
  await writeFile(join(repository, "renamed.txt"), "same\n");
  await writeFile(join(repository, "binary.dat"), Buffer.from([0, 1, 2]));
  await git(repository, ["add", "."]);
  await git(repository, [
    "-c",
    "user.name=OMP Remote",
    "-c",
    "user.email=omp@example.test",
    "commit",
    "-m",
    "base",
  ]);
  return repository;
}

describe("collectWorkingTreeDiff", () => {
  it("collects staged, unstaged, untracked, deleted, renamed, and binary working-tree changes", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "modified.txt"), "after\n");
    await rm(join(repository, "deleted.txt"));
    await git(repository, ["mv", "renamed.txt", "moved.txt"]);
    await writeFile(join(repository, "binary.dat"), Buffer.from([0, 3, 4]));
    await writeFile(join(repository, "staged.txt"), "staged\n");
    await git(repository, ["add", "staged.txt"]);
    await writeFile(join(repository, "untracked.txt"), "untracked\n");

    const nestedDirectory = join(repository, "nested");
    await mkdir(nestedDirectory);
    const result = await collectWorkingTreeDiff(nestedDirectory);

    expect(result.state).toBe("available");
    expect(result.root).toBe(await realpath(repository));
    expect(result.fileCount).toBe(6);
    expect(result.changedLines).toBe(5);
    expect(result.files.map(({ path, status }) => [path, status])).toEqual([
      ["binary.dat", "modified"],
      ["deleted.txt", "deleted"],
      ["modified.txt", "modified"],
      ["moved.txt", "renamed"],
      ["staged.txt", "added"],
      ["untracked.txt", "untracked"],
    ]);
    expect(result.files.find((file) => file.path === "binary.dat")).toMatchObject({ binary: true });
    expect(result.files.find((file) => file.path === "moved.txt")).toMatchObject({
      oldPath: "renamed.txt",
      additions: 0,
      deletions: 0,
    });
  });

  it("returns a non-destructive non-Git state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-remote-not-git-"));
    temporaryDirectories.push(directory);
    await expect(collectWorkingTreeDiff(directory)).resolves.toMatchObject({
      state: "not_git",
      root: null,
      files: [],
      fileCount: 0,
      changedLines: 0,
    });
  });
});

describe("Git diff parsers", () => {
  it("parses NUL-delimited rename records and paths containing spaces", () => {
    expect(parseGitStatus("R  moved file.txt\0old file.txt\0?? new file.txt\0")).toEqual([
      { path: "moved file.txt", oldPath: "old file.txt", status: "renamed" },
      { path: "new file.txt", status: "untracked" },
    ]);
  });

  it("counts only hunk additions and deletions", () => {
    expect(
      countPatchLines("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n"),
    ).toEqual({ additions: 1, deletions: 1 });
  });
});
