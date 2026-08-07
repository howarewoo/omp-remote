import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Session, SessionBranchTopology } from "@omp-remote/protocol";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 2_000;
const GIT_SWITCH_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1_024 * 1_024;
const GRAPHITE_COMMAND = ["log", "short", "--show-untracked", "--no-interactive"] as const;

type ExecFailure = Error & { stderr?: string };

function compareBranchNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertBranchSwitchSessionState(
  session: Pick<Session, "connected" | "source" | "status">,
): void {
  if (
    !session.connected ||
    session.source === "history" ||
    session.status === "disconnected" ||
    session.status === "history"
  ) {
    throw new Error("This OMP session is no longer connected.");
  }
  if (session.status === "running") {
    throw new Error("Cannot switch branches while the session is running.");
  }
}

async function execute(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number | null = GIT_COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    ...(timeoutMs === null ? {} : { timeout: timeoutMs }),
  }) as Promise<{ stdout: string; stderr: string }>;
}

function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as ExecFailure).stderr;
    if (typeof stderr === "string" && stderr.length > 0) return stderr.trimEnd();
  }
  return error instanceof Error ? error.message : "Git command failed";
}

export async function resolveGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execute("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveGitWorktree(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execute("git", ["rev-parse", "--show-toplevel"], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function listLocalGitBranches(cwd: string): Promise<string[]> {
  const { stdout } = await execute(
    "git",
    ["for-each-ref", "--format=%(refname:short)%00", "refs/heads"],
    cwd,
  );
  return [
    ...new Set(
      stdout
        .split("\0")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].sort(compareBranchNames);
}

type BranchRef = { name: string; objectName: string; timestamp: number };

async function listBranchRefs(cwd: string): Promise<BranchRef[]> {
  const { stdout } = await execute(
    "git",
    ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)%00", "refs/heads"],
    cwd,
  );
  const fields = stdout.split("\0");
  const refs: BranchRef[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const name = fields[index]?.trim();
    const objectName = fields[index + 1]?.trim();
    const timestamp = Number(fields[index + 2]?.trim());
    if (!name || !objectName || !Number.isFinite(timestamp))
      throw new Error("Git returned invalid branch refs");
    refs.push({ name, objectName, timestamp });
  }
  return refs;
}

function parseGraphiteOrder(output: string, branches: readonly string[]): string[] | null {
  const known = new Set(branches);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const marker = line.trim().replace(/^[│┃╎├└─>*+◉◯○●\s]+/u, "");
    const candidate = marker.split(/\s+/u, 1)[0];
    if (!candidate || !known.has(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    ordered.push(candidate);
  }
  return ordered.length === branches.length ? ordered : null;
}

async function resolveGraphiteOrder(cwd: string, branches: readonly string[]): Promise<string[] | null> {
  try {
    const { stdout } = await execute("gt", GRAPHITE_COMMAND, cwd);
    return parseGraphiteOrder(stdout, branches);
  } catch {
    return null;
  }
}

export type GraphiteOrderResolver = (
  cwd: string,
  branches: readonly string[],
) => Promise<readonly string[] | null>;

function validateGraphiteOrder(
  order: readonly string[] | null,
  branches: readonly string[],
): string[] | null {
  if (!order || order.length !== branches.length) return null;
  const known = new Set(branches);
  const seen = new Set<string>();
  for (const name of order) {
    if (!known.has(name) || seen.has(name)) return null;
    seen.add(name);
  }
  return seen.size === known.size ? [...order] : null;
}

const MAX_GIT_ANCESTRY_COMMITS = 50_000;
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/u;

function parseCommitGraph(output: string): Map<string, string[]> | null {
  const commits = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const fields = line.trim().split(/\s+/u);
    if (!fields[0] || !GIT_OBJECT_ID_PATTERN.test(fields[0])) return null;
    const parents = fields.slice(1);
    if (parents.some((parent) => !GIT_OBJECT_ID_PATTERN.test(parent))) return null;
    commits.set(fields[0], parents);
  }
  return commits;
}

async function projectParents(cwd: string, refs: readonly BranchRef[]): Promise<Map<string, string>> {
  const branchNamesByTip = new Map<string, string[]>();
  for (const ref of refs) {
    const names = branchNamesByTip.get(ref.objectName) ?? [];
    names.push(ref.name);
    names.sort(compareBranchNames);
    branchNamesByTip.set(ref.objectName, names);
  }
  const { stdout: output } = await execute(
    "git",
    [
      "rev-list",
      "--parents",
      "--topo-order",
      `--max-count=${MAX_GIT_ANCESTRY_COMMITS + 1}`,
      ...branchNamesByTip.keys(),
    ],
    cwd,
  );
  const commits = parseCommitGraph(output);
  if (!commits) throw new Error("Git returned an invalid commit graph");
  if (commits.size > MAX_GIT_ANCESTRY_COMMITS) {
    throw new Error("Git commit graph exceeds the supported topology limit");
  }

  type NearestBranch = { name: string; distance: number };
  const preferNearest = (current: NearestBranch | undefined, candidate: NearestBranch): NearestBranch =>
    !current ||
    candidate.distance < current.distance ||
    (candidate.distance === current.distance && compareBranchNames(candidate.name, current.name) < 0)
      ? candidate
      : current;

  const nearestBranchByCommit = new Map<string, NearestBranch>();
  for (const [commit, commitParents] of [...commits.entries()].reverse()) {
    const branchAtCommit = branchNamesByTip.get(commit)?.[0];
    let nearest = branchAtCommit ? { name: branchAtCommit, distance: 0 } : undefined;
    if (!nearest) {
      for (const parent of commitParents) {
        const parentBranch = nearestBranchByCommit.get(parent);
        if (parentBranch) {
          nearest = preferNearest(nearest, {
            name: parentBranch.name,
            distance: parentBranch.distance + 1,
          });
        }
      }
    }
    if (nearest) nearestBranchByCommit.set(commit, nearest);
  }

  const parents = new Map<string, string>();
  for (const child of refs) {
    let nearest: NearestBranch | undefined;
    for (const parent of commits.get(child.objectName) ?? []) {
      const parentBranch = nearestBranchByCommit.get(parent);
      if (parentBranch) {
        nearest = preferNearest(nearest, {
          name: parentBranch.name,
          distance: parentBranch.distance + 1,
        });
      }
    }
    if (nearest) parents.set(child.name, nearest.name);
  }
  return parents;
}
export async function loadGitBranchTopology(
  cwd: string,
  sessionId: string,
  graphiteOrderResolver: GraphiteOrderResolver = resolveGraphiteOrder,
): Promise<SessionBranchTopology | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentBranch = await resolveGitBranch(cwd);
    if (!currentBranch) return null;
    const refs = await listBranchRefs(cwd);
    const branchNames = refs.map((ref) => ref.name);
    if (!branchNames.includes(currentBranch)) return null;
    let graphiteOrder: readonly string[] | null = null;
    try {
      graphiteOrder = await graphiteOrderResolver(cwd, branchNames);
    } catch {
      // Graphite is an optional ordering hint; Git-native ordering remains complete.
    }
    const orderedNames =
      validateGraphiteOrder(graphiteOrder, branchNames) ?? [...branchNames].sort(compareBranchNames);
    const parents = await projectParents(cwd, refs);
    if ((await resolveGitBranch(cwd)) !== currentBranch) continue;
    return {
      sessionId,
      currentBranch,
      branches: orderedNames.map((name) => ({
        name,
        ...(parents.has(name) ? { parent: parents.get(name) } : {}),
      })),
    };
  }
  throw new Error("Git branch changed while loading topology");
}

export async function switchGitBranch(cwd: string, branch: string): Promise<void> {
  if (!branch || branch.startsWith("-")) throw new Error("The requested branch is not a local branch.");
  const branches = await listLocalGitBranches(cwd);
  if (!branches.includes(branch)) throw new Error("The requested branch is not a local branch.");
  try {
    await execute("git", ["switch", "--", branch], cwd, GIT_SWITCH_TIMEOUT_MS);
  } catch (error) {
    throw new Error(errorText(error));
  }
}
