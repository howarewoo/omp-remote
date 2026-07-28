import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = join(root, "apps", "daemon", "dist", "index.js");
await access(daemonEntry).catch(() => {
  throw new Error("Build OMP Remote before installing the service: pnpm build");
});

if (platform() === "darwin") {
  const label = "com.omp-remote.daemon";
  const agentsDirectory = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDirectory, `${label}.plist`);
  const logDirectory = join(homedir(), "Library", "Logs", "OMP Remote");
  await mkdir(agentsDirectory, { recursive: true });
  await mkdir(logDirectory, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${daemonEntry}</string></array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${join(logDirectory, "daemon.log")}</string>
  <key>StandardErrorPath</key><string>${join(logDirectory, "daemon.error.log")}</string>
</dict></plist>\n`;
  await writeFile(plistPath, plist, "utf8");
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
  const result = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("launchctl could not install OMP Remote");
  process.stdout.write(`Installed ${label} from ${plistPath}\n`);
} else if (platform() === "linux") {
  const unitDirectory = join(homedir(), ".config", "systemd", "user");
  const unitPath = join(unitDirectory, "omp-remote.service");
  await mkdir(unitDirectory, { recursive: true });
  const unit = `[Unit]
Description=OMP Remote private session dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${process.execPath} ${daemonEntry}
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
  await writeFile(unitPath, unit, "utf8");
  for (const args of [
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", "omp-remote.service"],
  ]) {
    const result = spawnSync("systemctl", args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`systemctl ${args.join(" ")} failed`);
  }
  process.stdout.write(`Installed omp-remote.service from ${unitPath}\n`);
} else {
  throw new Error(`Unsupported host platform: ${platform()}`);
}
