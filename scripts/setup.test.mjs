import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const setupPath = fileURLToPath(new URL("./setup.mjs", import.meta.url));

async function runSetup({ failCommand } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "omp-remote-setup-test-"));
  const capturePath = join(directory, "commands.jsonl");
  const executable = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");
const command = basename(process.argv[1]);
appendFileSync(process.env.SETUP_CAPTURE, JSON.stringify({ command, args: process.argv.slice(2) }) + "\\n");
if (process.env.SETUP_FAIL_COMMAND === command) process.exit(9);
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
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
        SETUP_CAPTURE: capturePath,
        SETUP_FAIL_COMMAND: failCommand ?? "",
      },
    });
    const commands = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { ...result, commands };
  } catch (error) {
    try {
      error.commands = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (captureError) {
      if (captureError.code !== "ENOENT") throw captureError;
      error.commands = [];
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("setup checks prerequisites and completes every installation step in order", async () => {
  const result = await runSetup();

  assert.deepEqual(result.commands, [
    { command: "omp", args: ["--version"] },
    { command: "tailscale", args: ["version"] },
    { command: "pnpm", args: ["install", "--frozen-lockfile"] },
    { command: "pnpm", args: ["run", "build"] },
    { command: "pnpm", args: ["run", "setup:extension"] },
    { command: "pnpm", args: ["run", "install:service"] },
    { command: "pnpm", args: ["run", "tailscale:serve"] },
  ]);
  assert.match(result.stdout, /OMP Remote setup is complete/);
  assert.match(result.stdout, /Start a new OMP terminal session/);
});

test("setup stops before installation when a prerequisite is unavailable", async () => {
  await assert.rejects(runSetup({ failCommand: "tailscale" }), (error) => {
    assert.equal(error.code, 1);
    assert.deepEqual(error.commands, [
      { command: "omp", args: ["--version"] },
      { command: "tailscale", args: ["version"] },
    ]);
    assert.match(error.stderr, /Tailscale is required/);
    return true;
  });
});
