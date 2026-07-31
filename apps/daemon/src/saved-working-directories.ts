import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const SavedWorkingDirectoriesSchema = z.array(z.string().trim().min(1));

export const DEFAULT_SAVED_WORKING_DIRECTORIES_PATH = resolve(
  homedir(),
  ".omp/remote/saved-working-directories.json",
);

export class SavedWorkingDirectoryStore {
  readonly #filePath: string;
  #directories: string[];
  #mutationQueue = Promise.resolve();

  private constructor(filePath: string, directories: string[]) {
    this.#filePath = filePath;
    this.#directories = directories;
  }

  static async load(
    filePath: string = DEFAULT_SAVED_WORKING_DIRECTORIES_PATH,
  ): Promise<SavedWorkingDirectoryStore> {
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return new SavedWorkingDirectoryStore(filePath, []);
      }
      throw error;
    }

    const parsed = SavedWorkingDirectoriesSchema.parse(JSON.parse(contents));
    return new SavedWorkingDirectoryStore(filePath, [...new Set(parsed)]);
  }

  list(): string[] {
    return [...this.#directories];
  }

  save(cwd: string): Promise<string[]> {
    const normalized = normalizeDirectory(cwd);
    return this.#mutate((current) => (current.includes(normalized) ? null : [...current, normalized]));
  }

  remove(cwd: string): Promise<string[]> {
    const normalized = normalizeDirectory(cwd);
    return this.#mutate((current) =>
      current.includes(normalized) ? current.filter((directory) => directory !== normalized) : null,
    );
  }

  #mutate(update: (current: readonly string[]) => string[] | null): Promise<string[]> {
    const mutation = this.#mutationQueue.then(async () => {
      const next = update(this.#directories);
      if (!next) return this.list();
      await persistAtomically(this.#filePath, next);
      this.#directories = next;
      return this.list();
    });
    this.#mutationQueue = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }
}

function normalizeDirectory(cwd: string): string {
  const normalized = cwd.trim();
  if (!normalized) throw new Error("Working directory must not be empty");
  return normalized;
}

async function persistAtomically(filePath: string, directories: readonly string[]): Promise<void> {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(directories, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
