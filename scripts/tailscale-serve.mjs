import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHealthUrl } from "./setup.mjs";

export function resolveServeTarget(environment = process.env) {
  return new URL(resolveHealthUrl(environment)).origin;
}

export function main() {
  const target = resolveServeTarget();
  const version = spawnSync("tailscale", ["version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error("Install and sign in to Tailscale before configuring OMP Remote");

  const serve = spawnSync("tailscale", ["serve", "--bg", target], { encoding: "utf8", timeout: 15_000 });
  if (serve.status !== 0) {
    const details = [serve.stdout, serve.stderr]
      .map((text) => text?.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(details || "tailscale serve could not expose OMP Remote");
  }

  const status = spawnSync("tailscale", ["serve", "status", "--json"], { encoding: "utf8" });
  if (status.status !== 0) throw new Error(status.stderr.trim() || "Could not verify Tailscale Serve");
  process.stdout.write(`${serve.stdout.trim()}\n${status.stdout.trim()}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
