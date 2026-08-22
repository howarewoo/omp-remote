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

function resolveServiceEndpoint(environment) {
  const host = environment.OMP_REMOTE_HOST;
  if (host !== undefined && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("OMP_REMOTE_HOST must be 127.0.0.1, ::1, or localhost");
  }

  const port = environment.OMP_REMOTE_PORT;
  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535)) {
    throw new Error("OMP_REMOTE_PORT must be an integer between 1 and 65535");
  }

  return { host, port };
}

export function renderLaunchAgent({
  label,
  nodePath,
  daemonEntry,
  root,
  logDirectory,
  servicePath,
  serviceHost,
  servicePort,
}) {
  const escapedPath = escapeXml(requireServicePath(servicePath));
  const endpointEnvironment = [
    serviceHost === undefined ? "" : `<key>OMP_REMOTE_HOST</key><string>${escapeXml(serviceHost)}</string>`,
    servicePort === undefined ? "" : `<key>OMP_REMOTE_PORT</key><string>${escapeXml(servicePort)}</string>`,
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key><array><string>${escapeXml(nodePath)}</string><string>${escapeXml(daemonEntry)}</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(root)}</string>
  <key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string><key>PATH</key><string>${escapedPath}</string>${endpointEnvironment}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${escapeXml(join(logDirectory, "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(logDirectory, "daemon.error.log"))}</string>
</dict></plist>\n`;
}

export function renderSystemdUnit({ nodePath, daemonEntry, root, servicePath, serviceHost, servicePort }) {
  const path = requireServicePath(servicePath);
  const endpointEnvironment = [
    serviceHost === undefined ? "" : `Environment=${quoteSystemd(`OMP_REMOTE_HOST=${serviceHost}`)}\n`,
    servicePort === undefined ? "" : `Environment=${quoteSystemd(`OMP_REMOTE_PORT=${servicePort}`)}\n`,
  ].join("");
  return `[Unit]
Description=OMP Remote private session dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=${quoteSystemd(root)}
ExecStart=${quoteSystemd(nodePath)} ${quoteSystemd(daemonEntry)}
Environment=NODE_ENV=production
Environment=${quoteSystemd(`PATH=${path}`)}
${endpointEnvironment}Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export async function installService({
  hostPlatform = platform(),
  homeDirectory = homedir(),
  runCommand = spawnSync,
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  environment = process.env,
} = {}) {
  const { host: serviceHost, port: servicePort } = resolveServiceEndpoint(environment);
  const daemonEntry = join(root, "apps", "daemon", "dist", "index.js");
  await access(daemonEntry).catch(() => {
    throw new Error("Build OMP Remote before installing the service: pnpm build");
  });

  if (hostPlatform === "darwin") {
    const label = "com.omp-remote.daemon";
    const agentsDirectory = join(homeDirectory, "Library", "LaunchAgents");
    const plistPath = join(agentsDirectory, `${label}.plist`);
    const logDirectory = join(homeDirectory, "Library", "Logs", "OMP Remote");
    await mkdir(agentsDirectory, { recursive: true });
    await mkdir(logDirectory, { recursive: true });
    const plist = renderLaunchAgent({
      label,
      nodePath: process.execPath,
      daemonEntry,
      root,
      logDirectory,
      servicePath: environment.PATH,
      serviceHost,
      servicePort,
    });
    await writeFile(plistPath, plist, "utf8");
    runCommand("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
    const result = runCommand("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], {
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error("launchctl could not install OMP Remote");
    process.stdout.write(`Installed ${label} from ${plistPath}\n`);
  } else if (hostPlatform === "linux") {
    const unitDirectory = join(homeDirectory, ".config", "systemd", "user");
    const unitPath = join(unitDirectory, "omp-remote.service");
    await mkdir(unitDirectory, { recursive: true });
    const unit = renderSystemdUnit({
      nodePath: process.execPath,
      daemonEntry,
      root,
      servicePath: environment.PATH,
      serviceHost,
      servicePort,
    });
    await writeFile(unitPath, unit, "utf8");
    for (const args of [
      ["--user", "daemon-reload"],
      ["--user", "enable", "omp-remote.service"],
      ["--user", "restart", "omp-remote.service"],
    ]) {
      const result = runCommand("systemctl", args, { stdio: "inherit" });
      if (result.status !== 0) throw new Error(`systemctl ${args.join(" ")} failed`);
    }
    process.stdout.write(`Installed omp-remote.service from ${unitPath}\n`);
  } else {
    throw new Error(`Unsupported host platform: ${hostPlatform}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installService();
}
