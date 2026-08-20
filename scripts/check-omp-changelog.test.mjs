import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildAuditReport,
  classifyOmpRemoteImpacts,
  compareSemver,
  detectSupportedVersion,
  executeUpgradeAndCreatePr,
  formatMarkdownReport,
  generatePrBranchName,
  generatePrMetadata,
  getDefaultStatePath,
  loadChangelogState,
  parseReleaseBody,
  parseSemver,
  runUpgradeVerification,
  saveChangelogState,
  UPGRADE_VERIFICATION_COMMANDS,
  updateChangelogState,
  updateReadmeContent,
  updateWorkspaceYamlContent,
} from "./check-omp-changelog.mjs";

const execFileAsync = promisify(execFile);
const checkerPath = fileURLToPath(new URL("./check-omp-changelog.mjs", import.meta.url));
const formatTestCommand = (command, args) => [command, ...args].join(" ");

test("parseSemver handles version strings with prefixes and pre-releases", () => {
  assert.deepEqual(parseSemver("17.1.8"), {
    major: 17,
    minor: 1,
    patch: 8,
    prerelease: "",
    raw: "17.1.8",
  });

  assert.deepEqual(parseSemver("v17.3.4"), {
    major: 17,
    minor: 3,
    patch: 4,
    prerelease: "",
    raw: "17.3.4",
  });

  assert.deepEqual(parseSemver("omp/18.0.0-rc.1"), {
    major: 18,
    minor: 0,
    patch: 0,
    prerelease: "rc.1",
    raw: "18.0.0-rc.1",
  });

  assert.deepEqual(parseSemver("17.2"), {
    major: 17,
    minor: 2,
    patch: 0,
    prerelease: "",
    raw: "17.2",
  });
});

test("compareSemver orders semantic versions accurately", () => {
  assert.ok(compareSemver("17.1.8", "17.2.0") < 0);
  assert.ok(compareSemver("17.2.0", "17.1.8") > 0);
  assert.equal(compareSemver("17.2.0", "17.2.0"), 0);
  assert.ok(compareSemver("17.2.15", "17.2.2") > 0);
  assert.ok(compareSemver("17.3.0", "17.3.0-rc.1") > 0);
  assert.ok(compareSemver("17.3.0-alpha", "17.3.0-beta") < 0);
});

test("detectSupportedVersion extracts version from pnpm-workspace.yaml", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "omp-remote-version-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(
    join(dir, "pnpm-workspace.yaml"),
    `catalog:\n  '@oh-my-pi/pi-coding-agent': 17.1.8\n  vitest: 4.1.10\n`,
    "utf8",
  );

  const detected = await detectSupportedVersion(dir);
  assert.equal(detected, "17.1.8");
});

test("loadChangelogState handles missing, corrupt, and valid state files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "omp-remote-state-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const missingPath = join(dir, "nonexistent.json");
  const missingState = await loadChangelogState(missingPath);
  assert.deepEqual(missingState, {
    lastCheckedVersion: null,
    lastCheckedAt: null,
    baseSupportedVersion: null,
    history: [],
  });

  const corruptPath = join(dir, "corrupt.json");
  await writeFile(corruptPath, "{ invalid json", "utf8");
  const corruptState = await loadChangelogState(corruptPath);
  assert.deepEqual(corruptState, {
    lastCheckedVersion: null,
    lastCheckedAt: null,
    baseSupportedVersion: null,
    history: [],
  });

  const validPath = join(dir, "valid.json");
  const sampleState = {
    lastCheckedVersion: "17.3.4",
    lastCheckedAt: "2026-08-15T12:00:00.000Z",
    baseSupportedVersion: "17.1.8",
    history: [
      {
        checkedAt: "2026-08-15T12:00:00.000Z",
        fromVersion: "17.1.8",
        toVersion: "17.3.4",
        releaseCount: 21,
        breakingChangeCount: 16,
      },
    ],
  };
  await saveChangelogState(validPath, sampleState);
  const loadedState = await loadChangelogState(validPath);
  assert.deepEqual(loadedState, sampleState);
});

test("updateChangelogState records check details and preserves history within bounds", () => {
  const initialState = {
    lastCheckedVersion: "17.1.8",
    lastCheckedAt: "2026-08-01T00:00:00.000Z",
    baseSupportedVersion: "17.1.8",
    history: [],
  };

  const updated = updateChangelogState(initialState, {
    fromVersion: "17.1.8",
    toVersion: "17.2.5",
    baseSupportedVersion: "17.1.8",
    checkedAt: "2026-08-10T10:00:00.000Z",
    report: {
      releaseCount: 8,
      summary: { breakingChangeCount: 3 },
    },
  });

  assert.equal(updated.lastCheckedVersion, "17.2.5");
  assert.equal(updated.lastCheckedAt, "2026-08-10T10:00:00.000Z");
  assert.equal(updated.baseSupportedVersion, "17.1.8");
  assert.equal(updated.history.length, 1);
  assert.deepEqual(updated.history[0], {
    checkedAt: "2026-08-10T10:00:00.000Z",
    fromVersion: "17.1.8",
    toVersion: "17.2.5",
    releaseCount: 8,
    breakingChangeCount: 3,
  });

  // Second update across version step
  const nextUpdate = updateChangelogState(updated, {
    fromVersion: "17.2.5",
    toVersion: "17.3.4",
    checkedAt: "2026-08-15T12:00:00.000Z",
    report: {
      releaseCount: 13,
      summary: { breakingChangeCount: 13 },
    },
  });

  assert.equal(nextUpdate.lastCheckedVersion, "17.3.4");
  assert.equal(nextUpdate.lastCheckedAt, "2026-08-15T12:00:00.000Z");
  assert.equal(nextUpdate.history.length, 2);
});

test("getDefaultStatePath returns path under .omp directory", () => {
  const defaultPath = getDefaultStatePath("/test/workspace");
  assert.equal(defaultPath, join("/test/workspace", ".omp", "changelog-state.json"));
});

test("updateWorkspaceYamlContent updates catalog and minimumReleaseAgeExclude entries", () => {
  const input = `catalog:
  '@oh-my-pi/pi-coding-agent': 17.1.8
minimumReleaseAgeExclude:
  - '@oh-my-pi/hashline@17.1.8'
  - '@oh-my-pi/pi-agent-core@17.1.8'
  - '@oh-my-pi/pi-coding-agent@17.1.8'
`;

  const updated = updateWorkspaceYamlContent(input, "17.3.4");
  assert.ok(updated.includes("'@oh-my-pi/pi-coding-agent': 17.3.4"));
  assert.ok(updated.includes("- '@oh-my-pi/hashline@17.3.4'"));
  assert.ok(updated.includes("- '@oh-my-pi/pi-agent-core@17.3.4'"));
  assert.ok(updated.includes("- '@oh-my-pi/pi-coding-agent@17.3.4'"));
  assert.ok(!updated.includes("17.1.8"));
});

test("updateReadmeContent updates the Stack table OMP integration entry", () => {
  const input = `| OMP integration | OMP SDK + RPC | \`17.1.8\` | Native lifecycle events |`;
  const updated = updateReadmeContent(input, "17.3.4");
  assert.equal(updated, `| OMP integration | OMP SDK + RPC | \`17.3.4\` | Native lifecycle events |`);
});

test("generatePrBranchName formats conventional branch name", () => {
  assert.equal(generatePrBranchName("17.3.4"), "upgrade-omp-to-v17-3-4");
  assert.equal(generatePrBranchName("18.0.0-rc.1"), "upgrade-omp-to-v18-0-0-rc-1");
});

test("generatePrMetadata builds structured title and body", () => {
  const report = {
    fromVersion: "17.1.8",
    toVersion: "17.3.4",
    releaseCount: 21,
    breakingChanges: [
      {
        release: "v17.2.0",
        package: "@oh-my-pi/hashline",
        description: "Removed DEL and COPY operations.",
      },
    ],
    summary: {
      breakingChangeCount: 1,
      affectedComponents: ["omp-extension", "protocol / sessions (transcript)"],
    },
  };

  const verification = [{ command: "pnpm test", status: "passed" }];
  const { title, body } = generatePrMetadata(report, { verification, checkpointSaved: true });
  assert.equal(title, "feat(omp): upgrade OMP integration to v17.3.4");
  assert.ok(body.includes("## Goal"));
  assert.ok(body.includes("Upgrade OMP integration from `17.1.8` to `17.3.4`"));
  assert.ok(body.includes("Regenerated `pnpm-lock.yaml`"));
  assert.ok(body.includes("Removed DEL and COPY operations."));
  assert.ok(body.includes("omp-extension"));
  assert.ok(body.includes("`pnpm test` — passed"));
  assert.ok(body.includes("Recorded audit checkpoint"));
  assert.ok(body.includes("## Test plan"));
});

test("executeUpgradeAndCreatePr preview works with dryRun", async () => {
  const report = {
    fromVersion: "17.1.8",
    toVersion: "17.3.4",
    releaseCount: 21,
    breakingChanges: [],
    summary: { breakingChangeCount: 0, affectedComponents: [] },
  };

  const result = await executeUpgradeAndCreatePr("/fake/dir", report, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.branchName, "upgrade-omp-to-v17-3-4");
  assert.ok(result.title.includes("v17.3.4"));
  assert.ok(result.body.includes("Upgrade OMP integration"));
  assert.ok(result.body.includes("pending dry run"));
  assert.ok(!result.body.includes("— passed"));
  assert.ok(result.body.includes("Audit checkpoint remains unchanged"));
});

test("runUpgradeVerification stops on the first failed gate", async () => {
  const calls = [];
  await assert.rejects(
    runUpgradeVerification("/workspace", async (command, args) => {
      calls.push([command, args]);
      if (args.includes("format:check")) throw new Error("format failed");
    }),
    /format failed/,
  );
  assert.deepEqual(calls, UPGRADE_VERIFICATION_COMMANDS.slice(0, 2));
});

test("executeUpgradeAndCreatePr locks, verifies, checkpoints, then submits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "omp-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "pnpm-workspace.yaml"),
    "catalog:\n  '@oh-my-pi/pi-coding-agent': 17.1.8\nminimumReleaseAgeExclude:\n  - '@oh-my-pi/hashline@17.1.8'\n",
  );
  await writeFile(
    join(directory, "README.md"),
    "| OMP integration | OMP SDK + RPC | `17.1.8` | Native lifecycle events |\n",
  );

  const calls = [];
  const runCommand = async (command, args) => {
    calls.push(formatTestCommand(command, args));
    if (command === "gt" && args[0] === "submit") {
      return { stdout: "https://app.graphite.com/github/pr/example/123\n" };
    }
    return { stdout: "" };
  };
  const report = {
    fromVersion: "17.1.8",
    toVersion: "17.3.4",
    releaseCount: 1,
    breakingChanges: [],
    summary: { breakingChangeCount: 0, affectedComponents: [] },
  };

  const result = await executeUpgradeAndCreatePr(directory, report, {
    runCommand,
    saveCheckpoint: async () => {
      calls.push("save checkpoint");
      return true;
    },
  });

  assert.deepEqual(calls.slice(0, 1), ["pnpm install --lockfile-only"]);
  assert.deepEqual(
    calls.slice(1, 1 + UPGRADE_VERIFICATION_COMMANDS.length),
    UPGRADE_VERIFICATION_COMMANDS.map(([command, args]) => formatTestCommand(command, args)),
  );
  assert.equal(calls[1 + UPGRADE_VERIFICATION_COMMANDS.length], "save checkpoint");
  assert.equal(
    calls[2 + UPGRADE_VERIFICATION_COMMANDS.length],
    "gt create --no-interactive -m feat(omp): upgrade OMP integration to v17.3.4",
  );
  assert.equal(result.verification.length, UPGRADE_VERIFICATION_COMMANDS.length);
  assert.ok(result.body.includes("Recorded audit checkpoint"));
  assert.ok(result.body.includes("pnpm run format:check` — passed"));
  assert.match(await readFile(join(directory, "pnpm-workspace.yaml"), "utf8"), /17\.3\.4/);
  assert.match(await readFile(join(directory, "README.md"), "utf8"), /17\.3\.4/);
});

test("parseReleaseBody parses packages and sections correctly", () => {
  const body = `
## @oh-my-pi/pi-coding-agent

### Breaking Changes

- Removed legacy DEL and DEL.BLK edit operations. Use CUT / CUT.BLK instead.

### Added

- Added \`ctx.invokeTool()\` to ExtensionContext.

## @oh-my-pi/omp-rpc

### Fixed

- Fixed memory leak in chunked message reassembly.
`;

  const release = parseReleaseBody(body, "v17.2.0");
  assert.equal(release.tag, "v17.2.0");
  assert.equal(release.version, "17.2.0");
  assert.equal(release.packages.length, 2);
  assert.equal(release.breakingChanges.length, 1);
  assert.equal(release.breakingChanges[0].package, "@oh-my-pi/pi-coding-agent");
  assert.ok(release.breakingChanges[0].description.includes("Removed legacy DEL"));
});

test("classifyOmpRemoteImpacts categorizes changes for omp-remote subsystems", () => {
  const release = {
    tag: "v17.2.0",
    version: "17.2.0",
    packages: [
      {
        name: "@oh-my-pi/pi-coding-agent",
        sections: {
          "Breaking Changes": [
            "Replaced direct zod re-exports with omptype compatibility facade in ExtensionAPI.",
          ],
          Added: ["Added set_fast_mode RPC command and token throughput metrics."],
        },
      },
      {
        name: "@oh-my-pi/hashline",
        sections: {
          "Breaking Changes": ["Unified SWAP and INS under PUT and CUT grammar."],
        },
      },
    ],
    breakingChanges: [],
  };

  const impacts = classifyOmpRemoteImpacts(release);
  assert.ok(impacts.length >= 3);

  const extensionImpact = impacts.find((i) => i.component === "omp-extension");
  assert.ok(extensionImpact);
  assert.ok(extensionImpact.item.includes("zod"));

  const rpcImpact = impacts.find((i) => i.component === "omp-rpc / daemon");
  assert.ok(rpcImpact);
  assert.ok(rpcImpact.item.includes("fast_mode"));

  const hashlineImpact = impacts.find((i) => i.component === "protocol / sessions (transcript)");
  assert.ok(hashlineImpact);
});

test("buildAuditReport and formatMarkdownReport produce a structured report", () => {
  const releases = [
    {
      tag: "v17.2.0",
      version: "17.2.0",
      publishedAt: "2026-08-01T00:00:00Z",
      packages: [
        {
          name: "@oh-my-pi/pi-coding-agent",
          sections: {
            "Breaking Changes": ["Changed ExtensionAPI zod export."],
          },
        },
      ],
      breakingChanges: [
        {
          package: "@oh-my-pi/pi-coding-agent",
          description: "Changed ExtensionAPI zod export.",
        },
      ],
    },
  ];

  const report = buildAuditReport("17.1.8", "17.2.0", releases, {
    baseSupportedVersion: "17.1.8",
    lastCheckedVersion: "17.1.8",
    lastCheckedAt: "2026-08-01T00:00:00.000Z",
    statePath: ".omp/changelog-state.json",
    stateSaved: true,
  });

  assert.equal(report.releaseCount, 1);
  assert.equal(report.summary.breakingChangeCount, 1);
  assert.ok(report.summary.affectedComponents.includes("omp-extension"));
  assert.equal(report.stateSaved, true);

  const markdown = formatMarkdownReport(report);
  assert.ok(markdown.includes("# OMP Remote Compatibility & Changelog Audit"));
  assert.ok(markdown.includes("`17.1.8` → `17.2.0`"));
  assert.ok(markdown.includes("Prior checked version"));
  assert.ok(markdown.includes("Breaking Changes Detected"));
  assert.ok(markdown.includes("Upgrade Checklist for omp-remote"));
});

test("formatMarkdownReport produces clean up-to-date message when release count is 0", () => {
  const report = buildAuditReport("17.3.4", "17.3.4", [], {
    baseSupportedVersion: "17.1.8",
    lastCheckedVersion: "17.3.4",
  });

  const markdown = formatMarkdownReport(report);
  assert.ok(markdown.includes("Up to Date"));
  assert.ok(markdown.includes("No new releases found"));
});

test("CLI supports --help flag", async () => {
  const { stdout } = await execFileAsync(process.execPath, [checkerPath, "--help"]);
  assert.ok(stdout.includes("Usage: node scripts/check-omp-changelog.mjs"));
  assert.ok(stdout.includes("--from <version>"));
  assert.ok(stdout.includes("--to <version>"));
  assert.ok(stdout.includes("--from-catalog"));
  assert.ok(stdout.includes("--create-pr"));
  assert.ok(stdout.includes("--dry-run"));
  assert.ok(stdout.includes("--state <path>"));
  assert.ok(stdout.includes("--save"));
  assert.ok(stdout.includes("--no-save"));
  assert.ok(stdout.includes("--json"));
});
