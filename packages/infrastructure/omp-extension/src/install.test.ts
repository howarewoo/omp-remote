import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function importInstalledExtension(runtime: "node" | "bun", target: string) {
  const targetUrl = pathToFileURL(target).href;
  const script = `const extension = await import(${JSON.stringify(targetUrl)}); if (typeof extension.default !== "function") throw new Error("missing extension registration");`;
  if (runtime === "node") {
    return execFileAsync(process.execPath, ["--input-type=module", "--eval", script]);
  }

  try {
    await execFileAsync("bun", ["--eval", script]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("installed extension artifact", () => {
  it("installs and imports without workspace runtime dependencies", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "omp-extension-install-"));
    temporaryDirectories.push(agentDirectory);

    await execFileAsync(process.execPath, [fileURLToPath(new URL("../dist/install.js", import.meta.url))], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
    });

    const target = join(agentDirectory, "extensions", "omp-remote.js");
    await expect(importInstalledExtension("node", target)).resolves.toMatchObject({
      stdout: expect.any(String),
      stderr: expect.any(String),
    });
    await importInstalledExtension("bun", target);
  });
});
