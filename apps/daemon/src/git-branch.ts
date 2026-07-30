import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 2_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1_024;

export async function resolveGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
