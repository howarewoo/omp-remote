import { spawn } from "node:child_process";
import { once } from "node:events";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4387;
const HEALTH_TIMEOUT_MS = 500;
const SHUTDOWN_GRACE_MS = 1_000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const LOOPBACK_HOSTS = new Set([DEFAULT_HOST, "::1", "localhost"]);

const host = process.env.OMP_REMOTE_HOST ?? DEFAULT_HOST;
if (!LOOPBACK_HOSTS.has(host)) {
  throw new Error("OMP_REMOTE_HOST must be 127.0.0.1, ::1, or localhost");
}

const portValue = process.env.OMP_REMOTE_PORT ?? String(DEFAULT_PORT);
if (!/^\d+$/.test(portValue)) {
  throw new Error("OMP_REMOTE_PORT must be an integer between 1 and 65535");
}
const port = Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("OMP_REMOTE_PORT must be an integer between 1 and 65535");
}

const urlHost = host.includes(":") ? `[${host}]` : host;
const healthUrl = `http://${urlHost}:${port}/healthz`;

async function hasHealthyDaemon() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) return false;

    const health = await response.json();
    return (
      health !== null &&
      typeof health === "object" &&
      health.status === "ok" &&
      health.service === "omp-remote" &&
      Number.isInteger(health.sessions) &&
      health.sessions >= 0 &&
      typeof health.timestamp === "string" &&
      Number.isFinite(Date.parse(health.timestamp))
    );
  } catch {
    return false;
  }
}

const healthyDaemon = await hasHealthyDaemon();
const turboArguments = ["run", "dev"];
if (healthyDaemon) turboArguments.push("--filter=@omp-remote/web");
turboArguments.push(...process.argv.slice(2));

console.log(
  healthyDaemon
    ? `Reusing OMP Remote daemon at http://${urlHost}:${port}`
    : `Starting OMP Remote development at http://${urlHost}:${port}`,
);

const child = spawn("turbo", turboArguments, {
  detached: process.platform !== "win32",
  env: process.env,
  stdio: "inherit",
});

function signalChild(signal) {
  if (child.pid === undefined) return;

  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

let receivedSignal;
let escalationTimer;
let escalationComplete = Promise.resolve();
const signalHandlers = new Map(
  FORWARDED_SIGNALS.map((signal) => [
    signal,
    () => {
      if (receivedSignal !== undefined) return;
      receivedSignal = signal;
      signalChild(signal);
      escalationComplete = new Promise((resolve) => {
        escalationTimer = setTimeout(() => {
          signalChild("SIGKILL");
          resolve();
        }, SHUTDOWN_GRACE_MS);
      });
    },
  ]),
);
for (const [signal, handler] of signalHandlers) process.on(signal, handler);

const [code, childSignal] = await once(child, "exit");
await escalationComplete;
clearTimeout(escalationTimer);
for (const [signal, handler] of signalHandlers) process.off(signal, handler);

const exitSignal = receivedSignal ?? childSignal;
if (exitSignal) process.kill(process.pid, exitSignal);
if (code === null) throw new Error("Turbo exited without an exit code or signal");
process.exitCode = code;
