import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const launcherPath = fileURLToPath(new URL("./dev.mjs", import.meta.url));
const HEALTH_PROBE_CI_BOUND_MS = 2_500;

async function listen(handler, host = "127.0.0.1") {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });

  const address = server.address();
  assert(address && typeof address === "object");
  return { server, port: address.port };
}
async function listenWithRejectedConnections() {
  const server = createTcpServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert(address && typeof address === "object");
  return { server, port: address.port };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function waitForProcessExit(pid) {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${pid} remained alive after shutdown escalation`);
}

async function runLauncher(overrides = {}, launcherArguments = []) {
  const directory = await mkdtemp(join(tmpdir(), "omp-remote-dev-test-"));
  const capturePath = join(directory, "turbo-call.json");
  const turboPath = join(directory, "turbo");
  await writeFile(
    turboPath,
    `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const capture = process.env.TURBO_CAPTURE;
function updateCapture(fields) {
  const invocation = JSON.parse(readFileSync(capture, "utf8"));
  writeFileSync(capture, JSON.stringify({ ...invocation, ...fields }));
}
writeFileSync(capture, JSON.stringify({ args: process.argv.slice(2), host: process.env.OMP_REMOTE_HOST, port: process.env.OMP_REMOTE_PORT, hasHost: Object.hasOwn(process.env, "OMP_REMOTE_HOST"), hasPort: Object.hasOwn(process.env, "OMP_REMOTE_PORT") }));
if (process.env.TURBO_SIGNAL_GROUP) {
  const descendantSource = 'const { writeFileSync } = require("node:fs"); const [marker, ready] = process.argv.slice(1); process.on("SIGTERM", () => writeFileSync(marker, "SIGTERM")); writeFileSync(ready, "ready"); setInterval(() => {}, 1_000);';
  const descendant = spawn(process.execPath, ["-e", descendantSource, process.env.TURBO_DESCENDANT_SIGNAL, process.env.TURBO_DESCENDANT_READY], { stdio: "ignore" });
  updateCapture({ turboPid: process.pid, descendantPid: descendant.pid });
  process.once("SIGTERM", () =>
    updateCapture({ receivedSignal: "SIGTERM", forwardedAt: Date.now() }),
  );
  const readyPoll = setInterval(() => {
    if (!existsSync(process.env.TURBO_DESCENDANT_READY)) return;
    clearInterval(readyPoll);
    process.kill(process.ppid, "SIGTERM");
  }, 10);
}
if (process.env.TURBO_SIGNAL_LAUNCHER) {
  const signal = process.env.TURBO_SIGNAL_LAUNCHER;
  process.on(signal, () => {
    updateCapture({ receivedSignal: signal });
    process.exit(0);
  });
  process.kill(process.ppid, signal);
  setInterval(() => {}, 1_000);
}
if (process.env.TURBO_SIGNAL) process.kill(process.pid, process.env.TURBO_SIGNAL);
if (process.env.TURBO_EXIT_CODE) process.exit(Number(process.env.TURBO_EXIT_CODE));
`,
  );
  await chmod(turboPath, 0o755);

  const env = { ...process.env };
  delete env.OMP_REMOTE_HOST;
  delete env.OMP_REMOTE_PORT;
  Object.assign(env, overrides, {
    PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
    TURBO_CAPTURE: capturePath,
    TURBO_DESCENDANT_READY: join(directory, "descendant-ready"),
    TURBO_DESCENDANT_SIGNAL: join(directory, "descendant-signal"),
  });

  let hardWatchdog;
  let watchdogError;
  try {
    try {
      const execution = execFileAsync(process.execPath, [launcherPath, ...launcherArguments], {
        env,
        timeout: 5_000,
      });
      if (env.TURBO_HARD_WATCHDOG_MS) {
        hardWatchdog = setTimeout(async () => {
          try {
            const invocation = JSON.parse(await readFile(capturePath, "utf8"));
            process.kill(-invocation.turboPid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ESRCH") watchdogError = error;
          }
          try {
            process.kill(execution.child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") watchdogError = error;
          }
        }, Number(env.TURBO_HARD_WATCHDOG_MS));
      }
      const result = await execution;
      const invocation = JSON.parse(await readFile(capturePath, "utf8"));
      return { ...result, invocation };
    } catch (error) {
      try {
        error.invocation = JSON.parse(await readFile(capturePath, "utf8"));
      } catch (captureError) {
        if (captureError.code !== "ENOENT") throw captureError;
      }
      try {
        error.descendantSignal = await readFile(env.TURBO_DESCENDANT_SIGNAL, "utf8");
      } catch (captureError) {
        if (captureError.code !== "ENOENT") throw captureError;
      }
      error.watchdogError = watchdogError;
      throw error;
    }
  } finally {
    clearTimeout(hardWatchdog);
    await rm(directory, { recursive: true, force: true });
  }
}

function assertFullDevelopmentGraph(invocation) {
  assert.deepEqual(invocation.args, ["run", "dev"]);
}

function assertWebOnlyDevelopment(invocation) {
  assert(
    invocation.args.length === 3 || invocation.args.length === 4,
    `expected exactly one Turbo web filter, received ${JSON.stringify(invocation.args)}`,
  );
  assert.deepEqual(invocation.args.slice(0, 2), ["run", "dev"]);
  if (invocation.args.length === 3) {
    assert.equal(invocation.args[2], "--filter=@omp-remote/web");
  } else {
    assert.deepEqual(invocation.args.slice(2), ["--filter", "@omp-remote/web"]);
  }
}

test("a healthy OMP Remote daemon selects only the web development task", async () => {
  let requestedUrl;
  const { server, port } = await listen((request, response) => {
    requestedUrl = request.url;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        service: "omp-remote",
        status: "ok",
        sessions: 1,
        timestamp: new Date().toISOString(),
      }),
    );
  });

  try {
    const { invocation } = await runLauncher({
      OMP_REMOTE_HOST: "127.0.0.1",
      OMP_REMOTE_PORT: String(port),
    });
    assert.equal(requestedUrl, "/healthz");
    assertWebOnlyDevelopment(invocation);
  } finally {
    await close(server);
  }
});

test("connection refusal selects the full development graph", async () => {
  const { server, port } = await listenWithRejectedConnections();

  try {
    const { invocation } = await runLauncher({
      OMP_REMOTE_HOST: "127.0.0.1",
      OMP_REMOTE_PORT: String(port),
    });
    assertFullDevelopmentGraph(invocation);
  } finally {
    await close(server);
  }
});

test("a malformed health response selects the full development graph", async () => {
  const { server, port } = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
  });

  try {
    const { invocation } = await runLauncher({
      OMP_REMOTE_HOST: "127.0.0.1",
      OMP_REMOTE_PORT: String(port),
    });
    assertFullDevelopmentGraph(invocation);
  } finally {
    await close(server);
  }
});

test("a generic impostor health response selects the full development graph", async () => {
  const { server, port } = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", sessions: 1, timestamp: new Date().toISOString() }));
  });

  try {
    const { invocation } = await runLauncher({
      OMP_REMOTE_HOST: "127.0.0.1",
      OMP_REMOTE_PORT: String(port),
    });
    assertFullDevelopmentGraph(invocation);
  } finally {
    await close(server);
  }
});

test("a timed-out health response selects the full development graph", { timeout: 7_000 }, async () => {
  const { server, port } = await listen(() => {});

  try {
    const startedAt = performance.now();
    const { invocation } = await runLauncher({
      OMP_REMOTE_HOST: "127.0.0.1",
      OMP_REMOTE_PORT: String(port),
    });
    const elapsed = performance.now() - startedAt;
    assert(
      elapsed < HEALTH_PROBE_CI_BOUND_MS,
      `health probe took ${elapsed}ms; expected a short bounded probe under ${HEALTH_PROBE_CI_BOUND_MS}ms`,
    );
    assertFullDevelopmentGraph(invocation);
  } finally {
    await close(server);
  }
});

test("an explicit loopback host and valid port are probed and preserved", async () => {
  let requestedHost;
  const { server, port } = await listen((request, response) => {
    requestedHost = request.headers.host;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        service: "omp-remote",
        status: "ok",
        sessions: 0,
        timestamp: new Date().toISOString(),
      }),
    );
  }, "localhost");

  try {
    const { invocation } = await runLauncher({
      OMP_REMOTE_HOST: "localhost",
      OMP_REMOTE_PORT: String(port),
    });
    assert.equal(requestedHost, `localhost:${port}`);
    assert.equal(invocation.host, "localhost");
    assert.equal(invocation.port, String(port));
    assertWebOnlyDevelopment(invocation);
  } finally {
    await close(server);
  }
});

test("unset endpoint overrides remain absent from Turbo", async () => {
  const { invocation } = await runLauncher();
  assert.equal(invocation.hasHost, false);
  assert.equal(invocation.hasPort, false);
});

test("CLI arguments and a nonzero Turbo exit are propagated", async () => {
  const { server, port } = await listenWithRejectedConnections();

  try {
    await assert.rejects(
      runLauncher(
        {
          OMP_REMOTE_HOST: "127.0.0.1",
          OMP_REMOTE_PORT: String(port),
          TURBO_EXIT_CODE: "23",
        },
        ["--dry=json"],
      ),
      (error) => {
        assert.equal(error.code, 23);
        assert.deepEqual(error.invocation.args, ["run", "dev", "--dry=json"]);
        return true;
      },
    );
  } finally {
    await close(server);
  }
});

test("a terminating Turbo signal is propagated", async () => {
  const { server, port } = await listenWithRejectedConnections();

  try {
    await assert.rejects(
      runLauncher({
        OMP_REMOTE_HOST: "127.0.0.1",
        OMP_REMOTE_PORT: String(port),
        TURBO_SIGNAL: "SIGTERM",
      }),
      (error) => {
        assert.equal(error.signal, "SIGTERM");
        assertFullDevelopmentGraph(error.invocation);
        return true;
      },
    );
  } finally {
    await close(server);
  }
});

test("a signal sent to the launcher terminates Turbo and is preserved", async () => {
  const { server, port } = await listenWithRejectedConnections();

  try {
    await assert.rejects(
      runLauncher({
        OMP_REMOTE_HOST: "127.0.0.1",
        OMP_REMOTE_PORT: String(port),
        TURBO_SIGNAL_LAUNCHER: "SIGTERM",
      }),
      (error) => {
        assert.equal(error.signal, "SIGTERM");
        assert.equal(error.invocation.receivedSignal, "SIGTERM");
        assertFullDevelopmentGraph(error.invocation);
        return true;
      },
    );
  } finally {
    await close(server);
  }
});

test("launcher shutdown escalates across the detached Turbo process group", {
  skip: process.platform === "win32",
  timeout: 7_000,
}, async () => {
  const { server, port } = await listenWithRejectedConnections();
  let launcherError;
  let cleanupError;

  try {
    try {
      await runLauncher({
        OMP_REMOTE_HOST: "127.0.0.1",
        OMP_REMOTE_PORT: String(port),
        TURBO_SIGNAL_GROUP: "1",
        TURBO_HARD_WATCHDOG_MS: "4000",
      });
      assert.fail("expected the launcher to terminate from SIGTERM");
    } catch (error) {
      launcherError = error;
    }

    assert.equal(launcherError.signal, "SIGTERM");
    assert.equal(launcherError.invocation.receivedSignal, "SIGTERM");
    assert.equal(launcherError.descendantSignal, "SIGTERM");
    assert.equal(launcherError.watchdogError, undefined);
    const escalationElapsed = Date.now() - launcherError.invocation.forwardedAt;
    assert(
      escalationElapsed >= 750 && escalationElapsed < 2_500,
      `process group exited ${escalationElapsed}ms after SIGTERM; expected the 1s grace window`,
    );
    assertFullDevelopmentGraph(launcherError.invocation);
    await waitForProcessExit(launcherError.invocation.turboPid);
    await waitForProcessExit(launcherError.invocation.descendantPid);
  } finally {
    const turboPid = launcherError?.invocation?.turboPid;
    if (Number.isInteger(turboPid)) {
      try {
        process.kill(-turboPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") cleanupError = error;
      }
    }
    await close(server);
  }

  if (cleanupError) throw cleanupError;
});

for (const [name, overrides, expectedMessage] of [
  ["host", { OMP_REMOTE_HOST: "0.0.0.0" }, /OMP_REMOTE_HOST/],
  ["port", { OMP_REMOTE_PORT: "0" }, /OMP_REMOTE_PORT/],
]) {
  test(`an invalid ${name} fails visibly`, async () => {
    await assert.rejects(runLauncher(overrides), (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, expectedMessage);
      return true;
    });
  });
}
