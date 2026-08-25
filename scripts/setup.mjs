import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_NODE_VERSION = "24.18.0";
const REQUIRED_PNPM_VERSION = "11.17.0";
const REQUIRED_OMP_VERSION = "18.0.0";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4387;
const LOOPBACK_HOSTS = new Set([DEFAULT_HOST, "::1", "localhost"]);
const READINESS_TIMEOUT_MS = 15_000;
const READINESS_INTERVAL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 500;

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match?.slice(1).map(Number);
}

export function validateNodeVersion(observed) {
  const version = parseSemver(observed);
  const required = parseSemver(REQUIRED_NODE_VERSION);
  if (
    !version ||
    version[0] < required[0] ||
    (version[0] === required[0] && version[1] < required[1]) ||
    (version[0] === required[0] && version[1] === required[1] && version[2] < required[2])
  ) {
    throw new Error(
      `Unsupported Node version: observed ${observed || "(malformed output)"}; required ${REQUIRED_NODE_VERSION} or newer.`,
    );
  }
}

export function validatePnpmVersion(output) {
  const observed = output.trim();
  if (observed !== REQUIRED_PNPM_VERSION) {
    throw new Error(
      `Unsupported pnpm version: observed ${observed || "(malformed output)"}; required exactly ${REQUIRED_PNPM_VERSION}.`,
    );
  }
}

export function validateOmpVersion(output) {
  const observed = output.trim();
  const match = /(?:^|\s)omp\/(\d+\.\d+\.\d+)(?=\s|$)/.exec(observed);
  if (!match || match[1] !== REQUIRED_OMP_VERSION) {
    throw new Error(
      `Unsupported OMP version: observed ${observed || "(malformed output)"}; required exactly omp/${REQUIRED_OMP_VERSION}.`,
    );
  }
}

function runPrerequisite(command, args, name, installUrl) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${name} is required. Install it from ${installUrl}, sign in, and rerun this command.`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function resolveHealthUrl(environment = process.env) {
  const host = environment.OMP_REMOTE_HOST ?? DEFAULT_HOST;
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("OMP_REMOTE_HOST must be 127.0.0.1, ::1, or localhost");
  }

  const portValue = environment.OMP_REMOTE_PORT ?? String(DEFAULT_PORT);
  if (!/^\d+$/.test(portValue)) {
    throw new Error("OMP_REMOTE_PORT must be an integer between 1 and 65535");
  }
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OMP_REMOTE_PORT must be an integer between 1 and 65535");
  }

  return `http://${host.includes(":") ? `[${host}]` : host}:${port}/healthz`;
}

async function probeDaemon(healthUrl, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(healthUrl, {
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return "unavailable";
  }
  if (!response.ok) return "impostor";

  try {
    const health = await response.json();
    if (health?.service !== "omp-remote") return "impostor";
    return health.status === "ok" ? "healthy" : "unavailable";
  } catch {
    return "impostor";
  }
}

export async function waitForHealthyDaemon({
  healthUrl,
  fetchImpl = fetch,
  timeoutMs = READINESS_TIMEOUT_MS,
  intervalMs = READINESS_INTERVAL_MS,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = await probeDaemon(healthUrl, fetchImpl);
    if (state === "healthy") return;
    if (state === "impostor") {
      throw new Error(
        `The configured daemon endpoint ${healthUrl} is occupied by a service other than OMP Remote.`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }

  throw new Error(`OMP Remote did not become healthy at ${healthUrl} within ${timeoutMs}ms.`);
}

export async function main() {
  process.stdout.write("Checking prerequisites...\n");
  validateNodeVersion(process.versions.node);
  validatePnpmVersion(runPrerequisite("pnpm", ["--version"], "pnpm", "https://pnpm.io/installation"));
  validateOmpVersion(runPrerequisite("omp", ["--version"], "OMP", "https://omp.sh"));
  runPrerequisite("tailscale", ["version"], "Tailscale", "https://tailscale.com/download");

  const healthUrl = resolveHealthUrl();
  const steps = [
    { label: "Installing dependencies", args: ["install", "--frozen-lockfile"] },
    { label: "Building OMP Remote", args: ["run", "build"] },
    { label: "Connecting terminal sessions", args: ["run", "setup:extension"] },
    { label: "Installing the background service", args: ["run", "install:service"] },
  ];

  for (const step of steps) {
    process.stdout.write(`\n${step.label}...\n`);
    const result = spawnSync("pnpm", step.args, { stdio: "inherit" });
    if (result.status === 0) continue;

    process.stderr.write(`\nSetup stopped while ${step.label.toLowerCase()}.\n`);
    return result.status ?? 1;
  }

  process.stdout.write("\nWaiting for the background service...\n");
  await waitForHealthyDaemon({ healthUrl });

  process.stdout.write("\nConfiguring private Tailscale access...\n");
  const serveResult = spawnSync("pnpm", ["run", "tailscale:serve"], { stdio: "inherit" });
  if (serveResult.status !== 0) {
    process.stderr.write("\nSetup stopped while configuring private tailscale access.\n");
    return serveResult.status ?? 1;
  }

  process.stdout.write(
    "\nOMP Remote setup is complete. Open the Tailscale URL above on your phone.\nStart a new OMP terminal session to make it appear in the dashboard.\n",
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
