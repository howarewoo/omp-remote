import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installService, renderLaunchAgent, renderSystemdUnit } from "./install-service.mjs";

const servicePath = `/Users/example/OMP & Tools/<current>/"quoted"/'single'/bin\\tools:/usr/%h/bin`;
const service = {
  daemonEntry: "/opt/omp %d/apps/daemon/dist/index.js",
  nodePath: "/opt/omp %N/bin/node",
  root: "/opt/omp %i",
  servicePath,
};

const missingPathError = {
  message: "PATH is required to install OMP Remote service",
};

test("launchd plist preserves the installation PATH with XML escaping", () => {
  const plist = renderLaunchAgent({
    ...service,
    label: "com.omp-remote.daemon",
    logDirectory: "/Users/example/Library/Logs/OMP Remote",
  });

  assert.match(
    plist,
    /<key>EnvironmentVariables<\/key><dict><key>NODE_ENV<\/key><string>production<\/string><key>PATH<\/key><string>\/Users\/example\/OMP &amp; Tools\/&lt;current&gt;\/&quot;quoted&quot;\/&apos;single&apos;\/bin\\tools:\/usr\/%h\/bin<\/string><\/dict>/,
  );
});

test("systemd unit preserves the installation PATH with unit quoting and escaping", () => {
  const unit = renderSystemdUnit(service);

  assert.match(unit, /^WorkingDirectory="\/opt\/omp %%i"$/m);
  assert.match(
    unit,
    /^ExecStart="\/opt\/omp %%N\/bin\/node" "\/opt\/omp %%d\/apps\/daemon\/dist\/index\.js"$/m,
  );
  assert.match(
    unit,
    /^Environment="PATH=\/Users\/example\/OMP & Tools\/<current>\/\\"quoted\\"\/'single'\/bin\\\\tools:\/usr\/%%h\/bin"$/m,
  );
});

test("service renderers persist configured loopback host and port overrides", () => {
  const endpoint = { serviceHost: "::1", servicePort: "4388" };
  const plist = renderLaunchAgent({
    ...service,
    ...endpoint,
    label: "com.omp-remote.daemon",
    logDirectory: "/Users/example/Library/Logs/OMP Remote",
  });
  const unit = renderSystemdUnit({ ...service, ...endpoint });

  assert.match(
    plist,
    /<key>OMP_REMOTE_HOST<\/key><string>::1<\/string><key>OMP_REMOTE_PORT<\/key><string>4388<\/string>/,
  );
  assert.match(unit, /^Environment="OMP_REMOTE_HOST=::1"$/m);
  assert.match(unit, /^Environment="OMP_REMOTE_PORT=4388"$/m);
});

test("service renderers reject a missing or blank installation PATH", () => {
  for (const invalidServicePath of [undefined, "", "   "]) {
    const invalidService = { ...service, servicePath: invalidServicePath };

    assert.throws(
      () =>
        renderLaunchAgent({
          ...invalidService,
          label: "com.omp-remote.daemon",
          logDirectory: "/Users/example/Library/Logs/OMP Remote",
        }),
      missingPathError,
    );
    assert.throws(() => renderSystemdUnit(invalidService), missingPathError);
  }
});

test("Linux reloads, enables, and restarts the freshly written service in order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-remote-service-test-"));
  const root = join(directory, "checkout");
  const daemonDirectory = join(root, "apps", "daemon", "dist");
  await mkdir(daemonDirectory, { recursive: true });
  await writeFile(join(daemonDirectory, "index.js"), "");
  const commands = [];

  try {
    await installService({
      hostPlatform: "linux",
      homeDirectory: directory,
      root,
      environment: {
        PATH: servicePath,
        OMP_REMOTE_HOST: "localhost",
        OMP_REMOTE_PORT: "4389",
      },
      runCommand(command, args) {
        commands.push({ command, args });
        return { status: 0 };
      },
    });

    assert.deepEqual(commands, [
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "omp-remote.service"] },
      { command: "systemctl", args: ["--user", "restart", "omp-remote.service"] },
    ]);
    const unit = await readFile(join(directory, ".config", "systemd", "user", "omp-remote.service"), "utf8");
    assert.match(unit, /^Environment="OMP_REMOTE_HOST=localhost"$/m);
    assert.match(unit, /^Environment="OMP_REMOTE_PORT=4389"$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
