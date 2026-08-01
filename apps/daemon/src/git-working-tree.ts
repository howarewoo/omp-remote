import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  SessionWorkingTreeDiffResponse,
  WorkingTreeDiffFile,
  WorkingTreeFileStatus,
} from "@omp-remote/protocol";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

type WorkingTreeCollection = Omit<SessionWorkingTreeDiffResponse, "sessionId">;
type StatusEntry = Pick<WorkingTreeDiffFile, "path" | "oldPath" | "status">;

type GitFailure = Error & {
  code?: string | number;
  killed?: boolean;
  stderr?: string;
  stdout?: string;
};

export async function collectWorkingTreeDiff(cwd: string): Promise<WorkingTreeCollection> {
  const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"], 64 * 1024);
  if (!rootResult.ok) {
    const details = `${rootResult.error.stderr ?? ""}\n${rootResult.error.message}`;
    return emptyCollection(
      details.includes("not a git repository") ? "not_git" : "unavailable",
      details.includes("not a git repository")
        ? "This working directory is not inside a Git repository."
        : "The working tree is unavailable on the host.",
    );
  }

  const root = rootResult.stdout.trim();
  if (!root) return emptyCollection("unavailable", "The Git repository root could not be resolved.");

  const statusResult = await runGit(
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    MAX_GIT_OUTPUT_BYTES,
  );
  if (!statusResult.ok) return failureCollection(root, statusResult.error);

  const entries = parseGitStatus(statusResult.stdout).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const files: WorkingTreeDiffFile[] = [];
  let outputBytes = Buffer.byteLength(statusResult.stdout);

  for (const entry of entries) {
    const args =
      entry.status === "untracked"
        ? ["diff", "--no-index", "--binary", "--no-ext-diff", "--no-color", "--", "/dev/null", entry.path]
        : [
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-color",
            "--find-renames",
            "HEAD",
            "--",
            ...(entry.oldPath ? [entry.oldPath] : []),
            entry.path,
          ];
    const patchResult = await runGit(root, args, MAX_GIT_OUTPUT_BYTES, entry.status === "untracked");
    if (!patchResult.ok) return failureCollection(root, patchResult.error);
    outputBytes += Buffer.byteLength(patchResult.stdout);
    if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
      return emptyCollection(
        "oversized",
        `The working-tree diff exceeds the ${formatByteLimit(MAX_GIT_OUTPUT_BYTES)} display limit.`,
        root,
      );
    }
    const counts = countPatchLines(patchResult.stdout);
    files.push({
      ...entry,
      ...counts,
      binary: /^(?:Binary files .* differ|GIT binary patch)$/m.test(patchResult.stdout),
      patch: patchResult.stdout,
    });
  }

  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  return {
    state: "available",
    root,
    files,
    fileCount: files.length,
    additions,
    deletions,
    changedLines: additions + deletions,
    message: null,
  };
}

export function parseGitStatus(output: string): StatusEntry[] {
  const fields = output.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (!path) continue;
    const status = statusFromCode(code);
    if (status === "renamed" || status === "copied") {
      const oldPath = fields[index + 1];
      if (oldPath) {
        entries.push({ path, oldPath, status });
        index += 1;
        continue;
      }
    }
    entries.push({ path, status });
  }
  return entries;
}

export function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("diff --git ")) {
      inHunk = false;
    } else if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function statusFromCode(code: string): WorkingTreeFileStatus {
  if (code === "??") return "untracked";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("T")) return "type_changed";
  if (code.includes("M")) return "modified";
  return "unknown";
}

async function runGit(
  cwd: string,
  args: string[],
  maxBuffer: number,
  acceptDifference = false,
): Promise<{ ok: true; stdout: string } | { ok: false; error: GitFailure }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer,
      timeout: GIT_TIMEOUT_MS,
    });
    return { ok: true, stdout };
  } catch (error) {
    const failure = error as GitFailure;
    if (acceptDifference && failure.code === 1) return { ok: true, stdout: failure.stdout ?? "" };
    return { ok: false, error: failure };
  }
}

function failureCollection(root: string, error: GitFailure): WorkingTreeCollection {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return emptyCollection(
      "oversized",
      `The working-tree diff exceeds the ${formatByteLimit(MAX_GIT_OUTPUT_BYTES)} display limit.`,
      root,
    );
  }
  return emptyCollection(
    "unavailable",
    error.killed
      ? "Git took too long to read this working tree. Try again."
      : "Git could not read this working tree on the host.",
    root,
  );
}

function emptyCollection(
  state: Exclude<WorkingTreeCollection["state"], "available">,
  message: string,
  root: string | null = null,
): WorkingTreeCollection {
  return {
    state,
    root,
    files: [],
    fileCount: 0,
    additions: 0,
    deletions: 0,
    changedLines: 0,
    message,
  };
}

function formatByteLimit(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}
