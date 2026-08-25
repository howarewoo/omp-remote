import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  resolveHealthUrl,
  validateNodeVersion,
  validateOmpVersion,
  validatePnpmVersion,
  waitForHealthyDaemon,
} from "./setup.mjs";

import { resolveServeTarget } from "./tailscale-serve.mjs";

const execFileAsync = promisify(execFile);
const setupPath = fileURLToPath(new URL("./setup.mjs", import.meta.url));

async function runSetup({
  failCommand,
  ompVersion = "omp/18.0.0",
  pnpmVersion = "11.17.0",
  environment = {},
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "omp-remote-setup-test-"));
  const capturePath = join(directory, "commands.jsonl");
  const executable = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.SETUP_CAPTURE, JSON.stringify({ command, args }) + "\\n");
if (process.env.SETUP_FAIL_COMMAND === command) process.exit(9);
if (command === "pnpm" && args[0] === "--version") process.stdout.write(process.env.SETUP_PNPM_VERSION);
if (command === "omp" && args[0] === "--version") process.stdout.write(process.env.SETUP_OMP_VERSION);
`;

  for (const command of ["omp", "pnpm", "tailscale"]) {
    const path = join(directory, command);
    await writeFile(path, executable);
    await chmod(path, 0o755);
  }

  try {
    const result = await execFileAsync(process.execPath, [setupPath], {
      env: {
        ...process.env,
        ...environment,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
        SETUP_CAPTURE: capturePath,
        SETUP_FAIL_COMMAND: failCommand ?? "",
        SETUP_OMP_VERSION: ompVersion,
        SETUP_PNPM_VERSION: pnpmVersion,
      },
    });
    return { ...result, commands: await readCommands(capturePath) };
  } catch (error) {
    error.commands = await readCommands(capturePath);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readCommands(capturePath) {
  try {
    return (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function listenForHealth(health) {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/healthz");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(health));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    port: server.address().port,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

test("supported versions are accepted", () => {
  for (const version of ["24.18.0", "24.18.1", "25.0.0"]) validateNodeVersion(version);
  validatePnpmVersion("11.17.0\n");
  validateOmpVersion("omp/18.0.0 darwin-arm64");
});

test("unsupported and malformed versions report observed and required versions", () => {
  assert.throws(() => validateNodeVersion("24.17.9"), /observed 24\.17\.9; required 24\.18\.0 or newer/);
  assert.throws(() => validateNodeVersion("not-semver"), /observed not-semver; required 24\.18\.0 or newer/);
  assert.throws(() => validatePnpmVersion("11.16.0"), /observed 11\.16\.0; required exactly 11\.17\.0/);
  assert.throws(
    () => validatePnpmVersion("pnpm 11.17.0"),
    /observed pnpm 11\.17\.0; required exactly 11\.17\.0/,
  );
  assert.throws(
    () => validateOmpVersion("omp/17.9.0"),
    /observed omp\/17\.9\.0; required exactly omp\/18\.0\.0/,
  );
  assert.throws(() => validateOmpVersion("18.0.0"), /observed 18\.0\.0; required exactly omp\/18\.0\.0/);
});

test("setup reaches Tailscale only after the freshly installed service is healthy", async () => {
  const health = await listenForHealth({ service: "omp-remote", status: "ok" });
  try {
    const result = await runSetup({
      environment: { OMP_REMOTE_HOST: "127.0.0.1", OMP_REMOTE_PORT: String(health.port) },
    });

    assert.deepEqual(result.commands, [
      { command: "pnpm", args: ["--version"] },
      { command: "omp", args: ["--version"] },
      { command: "tailscale", args: ["version"] },
      { command: "pnpm", args: ["install", "--frozen-lockfile"] },
      { command: "pnpm", args: ["run", "build"] },
      { command: "pnpm", args: ["run", "setup:extension"] },
      { command: "pnpm", args: ["run", "install:service"] },
      { command: "pnpm", args: ["run", "tailscale:serve"] },
    ]);
    assert.match(result.stdout, /Waiting for the background service/);
    assert.match(result.stdout, /OMP Remote setup is complete/);
  } finally {
    await health.close();
  }
});

test("setup stops before installation for unsupported pnpm or OMP", async () => {
  await assert.rejects(runSetup({ pnpmVersion: "11.16.0" }), (error) => {
    assert.equal(error.code, 1);
    assert.deepEqual(error.commands, [{ command: "pnpm", args: ["--version"] }]);
    assert.match(error.stderr, /required exactly 11\.17\.0/);
    return true;
  });

  await assert.rejects(runSetup({ ompVersion: "18.0.0" }), (error) => {
    assert.equal(error.code, 1);
    assert.deepEqual(error.commands, [
      { command: "pnpm", args: ["--version"] },
      { command: "omp", args: ["--version"] },
    ]);
    assert.match(error.stderr, /required exactly omp\/18\.0\.0/);
    return true;
  });
});

test("setup preserves missing OMP and Tailscale failures and stop order", async () => {
  await assert.rejects(runSetup({ failCommand: "omp" }), (error) => {
    assert.equal(error.code, 1);
    assert.deepEqual(error.commands, [
      { command: "pnpm", args: ["--version"] },
      { command: "omp", args: ["--version"] },
    ]);
    assert.match(error.stderr, /OMP is required/);
    return true;
  });

  await assert.rejects(runSetup({ failCommand: "tailscale" }), (error) => {
    assert.equal(error.code, 1);
    assert.deepEqual(error.commands, [
      { command: "pnpm", args: ["--version"] },
      { command: "omp", args: ["--version"] },
      { command: "tailscale", args: ["version"] },
    ]);
    assert.match(error.stderr, /Tailscale is required/);
    return true;
  });
});

test("an occupied endpoint fails readiness and never configures Tailscale Serve", async () => {
  const health = await listenForHealth({ service: "another-service", status: "ok" });
  try {
    await assert.rejects(
      runSetup({
        environment: { OMP_REMOTE_HOST: "127.0.0.1", OMP_REMOTE_PORT: String(health.port) },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /occupied by a service other than OMP Remote/);
        assert.deepEqual(error.commands.at(-1), {
          command: "pnpm",
          args: ["run", "install:service"],
        });
        assert.equal(
          error.commands.some(
            ({ command, args }) => command === "pnpm" && args.join(" ") === "run tailscale:serve",
          ),
          false,
        );
        return true;
      },
    );
  } finally {
    await health.close();
  }
});

test("readiness times out while OMP Remote remains unhealthy", async () => {
  let probes = 0;
  await assert.rejects(
    waitForHealthyDaemon({
      healthUrl: "http://127.0.0.1:4387/healthz",
      fetchImpl: async () => {
        probes += 1;
        return new Response(JSON.stringify({ service: "omp-remote", status: "starting" }));
      },
      timeoutMs: 0,
      intervalMs: 0,
    }),
    /did not become healthy/,
  );
  assert.equal(probes, 1);
});

test("setup endpoint overrides remain inside the daemon loopback and port contract", () => {
  assert.equal(
    resolveHealthUrl({ OMP_REMOTE_HOST: "::1", OMP_REMOTE_PORT: "4388" }),
    "http://[::1]:4388/healthz",
  );
  assert.throws(
    () => resolveHealthUrl({ OMP_REMOTE_HOST: "0.0.0.0", OMP_REMOTE_PORT: "4387" }),
    /OMP_REMOTE_HOST/,
  );
  assert.throws(
    () => resolveHealthUrl({ OMP_REMOTE_HOST: "localhost", OMP_REMOTE_PORT: "65536" }),
    /OMP_REMOTE_PORT/,
  );
});

test("Tailscale Serve uses the configured daemon endpoint", () => {
  assert.equal(resolveServeTarget({ OMP_REMOTE_HOST: "::1", OMP_REMOTE_PORT: "4388" }), "http://[::1]:4388");
  assert.equal(resolveServeTarget({}), "http://127.0.0.1:4387");
});
