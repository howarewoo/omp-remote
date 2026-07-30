import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const missingPathMessage = "PATH is required to install OMP Remote service";

function requireServicePath(servicePath) {
  if (typeof servicePath !== "string" || servicePath.trim() === "") {
    throw new Error(missingPathMessage);
  }
  return servicePath;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteSystemd(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function renderLaunchAgent({
  label,
  nodePath,
  daemonEntry,
  root,
  logDirectory,
  servicePath,
}) {
  const escapedPath = escapeXml(requireServicePath(servicePath));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key><array><string>${escapeXml(nodePath)}</string><string>${escapeXml(daemonEntry)}</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(root)}</string>
  <key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string><key>PATH</key><string>${escapedPath}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${escapeXml(join(logDirectory, "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(logDirectory, "daemon.error.log"))}</string>
</dict></plist>\n`;
}

export function renderSystemdUnit({ nodePath, daemonEntry, root, servicePath }) {
  const path = requireServicePath(servicePath);
  return `[Unit]
Description=OMP Remote private session dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=${quoteSystemd(root)}
ExecStart=${quoteSystemd(nodePath)} ${quoteSystemd(daemonEntry)}
Environment=NODE_ENV=production
Environment=${quoteSystemd(`PATH=${path}`)}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

async function installService() {
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
    const plist = renderLaunchAgent({
      label,
      nodePath: process.execPath,
      daemonEntry,
      root,
      logDirectory,
      servicePath: process.env.PATH,
    });
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
    const unit = renderSystemdUnit({
      nodePath: process.execPath,
      daemonEntry,
      root,
      servicePath: process.env.PATH,
    });
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installService();
}
