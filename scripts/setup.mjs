import { spawnSync } from "node:child_process";

const prerequisites = [
  { command: "omp", args: ["--version"], name: "OMP", installUrl: "https://omp.sh" },
  {
    command: "tailscale",
    args: ["version"],
    name: "Tailscale",
    installUrl: "https://tailscale.com/download",
  },
];

process.stdout.write("Checking prerequisites...\n");
for (const prerequisite of prerequisites) {
  const result = spawnSync(prerequisite.command, prerequisite.args, { stdio: "ignore" });
  if (result.status === 0) continue;

  process.stderr.write(
    `${prerequisite.name} is required. Install it from ${prerequisite.installUrl}, sign in, and rerun this command.\n`,
  );
  process.exit(1);
}

const steps = [
  { label: "Installing dependencies", args: ["install", "--frozen-lockfile"] },
  { label: "Building OMP Remote", args: ["run", "build"] },
  { label: "Connecting terminal sessions", args: ["run", "setup:extension"] },
  { label: "Installing the background service", args: ["run", "install:service"] },
  { label: "Configuring private Tailscale access", args: ["run", "tailscale:serve"] },
];

for (const step of steps) {
  process.stdout.write(`\n${step.label}...\n`);
  const result = spawnSync("pnpm", step.args, { stdio: "inherit" });
  if (result.status === 0) continue;

  process.stderr.write(`\nSetup stopped while ${step.label.toLowerCase()}.\n`);
  process.exit(result.status ?? 1);
}

process.stdout.write(
  "\nOMP Remote setup is complete. Open the Tailscale URL above on your phone.\nStart a new OMP terminal session to make it appear in the dashboard.\n",
);
