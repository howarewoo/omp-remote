import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "extension.js");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
const targetDirectory = join(agentDirectory, "extensions");
const target = join(targetDirectory, "omp-remote.js");

await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);
process.stdout.write(`Installed OMP Remote extension at ${target}\n`);
