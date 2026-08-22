import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionRoots } from "./session-catalog.js";

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
