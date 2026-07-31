import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SavedWorkingDirectoryStore } from "./saved-working-directories.js";

const temporaryDirectories: string[] = [];

async function createStorePath(): Promise<{ root: string; filePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "omp-remote-saved-directories-"));
  temporaryDirectories.push(root);
  return { root, filePath: join(root, "config", "saved-working-directories.json") };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("SavedWorkingDirectoryStore", () => {
  it("persists ordered paths and loads them after a restart", async () => {
    const { filePath } = await createStorePath();
    const store = await SavedWorkingDirectoryStore.load(filePath);

    await store.save("  /workspace/one  ");
    await store.save("/workspace/two");

    const restarted = await SavedWorkingDirectoryStore.load(filePath);
    expect(restarted.list()).toEqual(["/workspace/one", "/workspace/two"]);
    await expect(readFile(filePath, "utf8")).resolves.toBe('[\n  "/workspace/one",\n  "/workspace/two"\n]\n');
  });

  it("deduplicates exact trimmed paths while preserving insertion order", async () => {
    const { filePath } = await createStorePath();
    const store = await SavedWorkingDirectoryStore.load(filePath);

    await Promise.all([
      store.save("/workspace/one"),
      store.save(" /workspace/one "),
      store.save("/workspace/two"),
    ]);

    expect(store.list()).toEqual(["/workspace/one", "/workspace/two"]);
    await expect(SavedWorkingDirectoryStore.load(filePath)).resolves.toMatchObject({});
    expect((await SavedWorkingDirectoryStore.load(filePath)).list()).toEqual([
      "/workspace/one",
      "/workspace/two",
    ]);
  });

  it("removes only the exact trimmed path", async () => {
    const { filePath } = await createStorePath();
    const store = await SavedWorkingDirectoryStore.load(filePath);
    await store.save("/workspace/project");
    await store.save("/workspace/Project");

    await expect(store.remove("  /workspace/project ")).resolves.toEqual(["/workspace/Project"]);
    expect((await SavedWorkingDirectoryStore.load(filePath)).list()).toEqual(["/workspace/Project"]);
  });

  it("surfaces malformed persisted content", async () => {
    const { root, filePath } = await createStorePath();
    await writeFile(join(root, "malformed.json"), "not json", "utf8");
    await writeFile(join(root, "wrong-shape.json"), '{"cwd":"/workspace"}', "utf8");

    await expect(SavedWorkingDirectoryStore.load(join(root, "malformed.json"))).rejects.toThrow();
    await expect(SavedWorkingDirectoryStore.load(join(root, "wrong-shape.json"))).rejects.toThrow();
    await expect(SavedWorkingDirectoryStore.load(filePath)).resolves.toBeInstanceOf(
      SavedWorkingDirectoryStore,
    );
  });

  it("keeps memory unchanged after failed persistence and accepts a later mutation", async () => {
    const { root, filePath } = await createStorePath();
    const store = await SavedWorkingDirectoryStore.load(filePath);
    const blockedParent = join(root, "config");
    await writeFile(blockedParent, "not a directory", "utf8");

    await expect(store.save("/workspace/failed")).rejects.toThrow();
    expect(store.list()).toEqual([]);

    await unlink(blockedParent);
    await expect(store.save("/workspace/recovered")).resolves.toEqual(["/workspace/recovered"]);
    expect((await SavedWorkingDirectoryStore.load(filePath)).list()).toEqual(["/workspace/recovered"]);
  });
});
