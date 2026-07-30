import assert from "node:assert/strict";
import test from "node:test";

import { renderLaunchAgent, renderSystemdUnit } from "./install-service.mjs";

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
