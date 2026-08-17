import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ErrorLogEntry, ErrorObserver } from "@omp-remote/observability";
import {
  APPLICATION_ERROR_MESSAGE_MAX_CHARS,
  APPLICATION_ERROR_NAME_MAX_CHARS,
  APPLICATION_ERROR_STACK_MAX_CHARS,
  type ApplicationErrorInput,
  ApplicationErrorInputSchema,
  type ApplicationErrorLedgerResponse,
  type ApplicationErrorRecord,
  ApplicationErrorRecordSchema,
  type ApplicationErrorStorageHealth,
  type ApplicationErrorStorageStatus,
  boundApplicationErrorRecords,
  type PersistedApplicationErrorsState,
  PersistedApplicationErrorsStateSchema,
  sanitizeApplicationErrorContext,
} from "@omp-remote/protocol";

export const DEFAULT_APPLICATION_ERRORS_PATH = resolve(homedir(), ".omp/remote/errors.json");
const CURRENT_VERSION = 1;

export type Persistence = (filePath: string, state: PersistedApplicationErrorsState) => Promise<void>;

export class ApplicationErrorStore {
  readonly #filePath: string;
  #records: ApplicationErrorRecord[];
  #status: ApplicationErrorStorageStatus;
  #degradedReason: string | null;
  #mutationQueue = Promise.resolve();
  readonly #persist: Persistence;

  private constructor(
    filePath: string,
    records: ApplicationErrorRecord[],
    status: ApplicationErrorStorageStatus,
    degradedReason: string | null,
    persist: Persistence,
  ) {
    this.#filePath = filePath;
    this.#records = records;
    this.#status = status;
    this.#degradedReason = degradedReason;
    this.#persist = persist;
  }

  static async load(
    filePath: string = DEFAULT_APPLICATION_ERRORS_PATH,
    persist: Persistence = persistAtomically,
  ): Promise<ApplicationErrorStore> {
    const parent = dirname(filePath);
    try {
      await ensurePrivateDirectory(parent);
    } catch (error) {
      return new ApplicationErrorStore(
        filePath,
        [],
        "degraded",
        `Failed to access storage directory: ${error instanceof Error ? error.message : String(error)}`,
        persist,
      );
    }

    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingPathError(error)) {
        return new ApplicationErrorStore(filePath, [], "healthy", null, persist);
      }
      return new ApplicationErrorStore(
        filePath,
        [],
        "degraded",
        `Failed to read storage file: ${error instanceof Error ? error.message : String(error)}`,
        persist,
      );
    }

    try {
      await chmod(filePath, 0o600);
    } catch {
      // Non-fatal if filesystem ignores chmod
    }

    try {
      const parsedJson = JSON.parse(contents);
      const parsedState = PersistedApplicationErrorsStateSchema.parse(parsedJson);
      const boundedRecords = boundApplicationErrorRecords(parsedState.errors);
      return new ApplicationErrorStore(filePath, boundedRecords, "healthy", null, persist);
    } catch (error) {
      // Corruption preservation: keep corrupt file intact without overwriting or deleting
      return new ApplicationErrorStore(
        filePath,
        [],
        "degraded",
        `Corrupted application errors file: ${error instanceof Error ? error.message : String(error)}`,
        persist,
      );
    }
  }

  get status(): ApplicationErrorStorageStatus {
    return this.#status;
  }

  get degradedReason(): string | null {
    return this.#degradedReason;
  }

  getHealth(): ApplicationErrorStorageHealth {
    const recordCount = this.#records.length;
    const serialized = serializeState({ version: CURRENT_VERSION, errors: this.#records });
    const totalBytes = Buffer.byteLength(serialized, "utf8");
    const oldestTimestamp = this.#records[0]?.timestamp ?? null;
    const newestTimestamp = this.#records[this.#records.length - 1]?.timestamp ?? null;

    return {
      status: this.#status,
      recordCount,
      totalBytes,
      oldestTimestamp,
      newestTimestamp,
      degradedReason: this.#degradedReason,
    };
  }

  list(): ApplicationErrorRecord[] {
    return this.#records.map((record) => ({
      ...record,
      ...(record.context ? { context: { ...record.context } } : {}),
    }));
  }

  getLedger(): ApplicationErrorLedgerResponse {
    return {
      errors: this.list(),
      health: this.getHealth(),
    };
  }

  async record(input: ApplicationErrorInput): Promise<ApplicationErrorRecord> {
    const record = normalizeAndValidateRecord(input);
    await this.#mutate((current) => {
      const next = [...current, record];
      return boundApplicationErrorRecords(next);
    });
    return record;
  }

  async recordFromLogEntry(entry: ErrorLogEntry): Promise<ApplicationErrorRecord | null> {
    try {
      const sanitizedContext = sanitizeApplicationErrorContext(entry.fields);
      const rawMessage = entry.message || "Unknown error";
      const message = rawMessage.slice(0, APPLICATION_ERROR_MESSAGE_MAX_CHARS);
      const errorName = entry.error?.name ? entry.error.name.slice(0, APPLICATION_ERROR_NAME_MAX_CHARS) : undefined;
      const stack = entry.error?.stack ? entry.error.stack.slice(0, APPLICATION_ERROR_STACK_MAX_CHARS) : undefined;

      const input: ApplicationErrorInput = {
        source: "daemon",
        severity: "error",
        message,
        errorName,
        stack,
        context: sanitizedContext,
        timestamp: entry.timestamp,
      };
      return await this.record(input);
    } catch {
      return null;
    }
  }

  createObserver(): ErrorObserver {
    return (entry: ErrorLogEntry) => {
      this.recordFromLogEntry(entry).catch(() => undefined);
    };
  }

  async clear(): Promise<{ clearedCount: number }> {
    let clearedCount = 0;
    await this.#mutate((current) => {
      clearedCount = current.length;
      return [];
    });
    return { clearedCount };
  }

  #mutate(
    update: (current: readonly ApplicationErrorRecord[]) => ApplicationErrorRecord[],
  ): Promise<ApplicationErrorRecord[]> {
    const mutation = this.#mutationQueue.then(async () => {
      const nextRecords = update(this.#records);
      const nextState: PersistedApplicationErrorsState = {
        version: CURRENT_VERSION,
        errors: nextRecords,
      };
      try {
        await this.#persist(this.#filePath, nextState);
        this.#records = nextRecords;
        this.#status = "healthy";
        this.#degradedReason = null;
        return this.list();
      } catch (error) {
        this.#status = "degraded";
        this.#degradedReason = `Persistence failed: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      }
    });

    this.#mutationQueue = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }
}

function normalizeAndValidateRecord(input: ApplicationErrorInput): ApplicationErrorRecord {
  const parsedInput = ApplicationErrorInputSchema.parse(input);
  const id = parsedInput.id ?? randomUUID();
  const timestamp = parsedInput.timestamp ?? new Date().toISOString();
  const severity = parsedInput.severity;
  const source = parsedInput.source;
  const message = parsedInput.message;
  const errorName = parsedInput.errorName;
  const stack = parsedInput.stack;
  const context = parsedInput.context;

  return ApplicationErrorRecordSchema.parse({
    id,
    timestamp,
    source,
    severity,
    message,
    ...(errorName ? { errorName } : {}),
    ...(stack ? { stack } : {}),
    ...(context ? { context } : {}),
  });
}

function serializeState(state: PersistedApplicationErrorsState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function persistAtomically(filePath: string, state: PersistedApplicationErrorsState): Promise<void> {
  const parent = dirname(filePath);
  await ensurePrivateDirectory(parent);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const serialized = serializeState(state);
    await writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
