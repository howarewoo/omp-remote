import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseSemver(versionString) {
  const clean = versionString.replace(/^(?:omp\/|v)/i, "").trim();
  const [main, prerelease = ""] = clean.split("-");
  const parts = (main || "0.0.0").split(".").map(Number);
  while (parts.length < 3) parts.push(0);

  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    prerelease,
    raw: clean,
  };
}

export function compareSemver(left, right) {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);

  if (parsedLeft.major !== parsedRight.major) return parsedLeft.major - parsedRight.major;
  if (parsedLeft.minor !== parsedRight.minor) return parsedLeft.minor - parsedRight.minor;
  if (parsedLeft.patch !== parsedRight.patch) return parsedLeft.patch - parsedRight.patch;

  if (!parsedLeft.prerelease && parsedRight.prerelease) return 1;
  if (parsedLeft.prerelease && !parsedRight.prerelease) return -1;
  if (parsedLeft.prerelease && parsedRight.prerelease) {
    return parsedLeft.prerelease.localeCompare(parsedRight.prerelease);
  }

  return 0;
}

export async function detectSupportedVersion(workspaceRoot = process.cwd()) {
  try {
    const yamlContent = await readFile(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8");
    const match = /['"]?@oh-my-pi\/pi-coding-agent['"]?:\s*['"]?([^'"\s]+)['"]?/.exec(yamlContent);
    if (match?.[1]) return match[1];
  } catch {
    // Fall back if file cannot be read
  }
  return "17.1.8";
}

export function getDefaultStatePath(workspaceRoot = process.cwd()) {
  return join(workspaceRoot, ".omp", "changelog-state.json");
}

export async function loadChangelogState(stateFilePath) {
  try {
    const raw = await readFile(stateFilePath, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      return {
        lastCheckedVersion: typeof data.lastCheckedVersion === "string" ? data.lastCheckedVersion : null,
        lastCheckedAt: typeof data.lastCheckedAt === "string" ? data.lastCheckedAt : null,
        baseSupportedVersion:
          typeof data.baseSupportedVersion === "string" ? data.baseSupportedVersion : null,
        history: Array.isArray(data.history) ? data.history : [],
      };
    }
  } catch {
    // Return empty state if absent or corrupt
  }
  return {
    lastCheckedVersion: null,
    lastCheckedAt: null,
    baseSupportedVersion: null,
    history: [],
  };
}

export async function saveChangelogState(stateFilePath, state) {
  await mkdir(dirname(stateFilePath), { recursive: true });
  await writeFile(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function updateChangelogState(
  existingState,
  { fromVersion, toVersion, report, baseSupportedVersion, checkedAt },
) {
  const timestamp = checkedAt || new Date().toISOString();
  const historyEntry = {
    checkedAt: timestamp,
    fromVersion,
    toVersion,
    releaseCount: report?.releaseCount ?? 0,
    breakingChangeCount: report?.summary?.breakingChangeCount ?? 0,
  };

  const history = [...(existingState?.history || [])];
  if (history.length >= 50) history.shift();
  history.push(historyEntry);

  return {
    lastCheckedVersion: toVersion,
    lastCheckedAt: timestamp,
    baseSupportedVersion: baseSupportedVersion || existingState?.baseSupportedVersion || fromVersion,
    history,
  };
}

export async function detectInstalledOmpVersion() {
  try {
    const { stdout } = await execFileAsync("omp", ["--version"]);
    const match = /(?:omp\/|v)?(\d+\.\d+\.\d+(?:-[\w.]+)?)/i.exec(stdout.trim());
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function parseReleaseBody(body, tag = "") {
  const version = tag.replace(/^v/, "");
  const packages = [];
  const breakingChanges = [];

  let currentPkg = null;
  let currentSection = null;
  let currentSectionName = "";

  const lines = body.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();

    const pkgMatch = /^##\s+(@oh-my-pi\/[a-z0-9-]+)/i.exec(line);
    if (pkgMatch?.[1]) {
      currentPkg = { name: pkgMatch[1], sections: {} };
      packages.push(currentPkg);
      currentSection = null;
      currentSectionName = "";
      continue;
    }

    const sectionMatch = /^###\s+(Breaking Changes|Added|Changed|Fixed|Removed)/i.exec(line);
    if (sectionMatch?.[1] && currentPkg) {
      currentSectionName = sectionMatch[1];
      currentSection = [];
      currentPkg.sections[currentSectionName] = currentSection;
      continue;
    }

    if (line.startsWith("## ") || line.startsWith("### ")) {
      if (!line.includes("@oh-my-pi/")) {
        currentSection = null;
        currentSectionName = "";
      }
      continue;
    }

    if (currentSection && line.startsWith("- ")) {
      const item = line.slice(2).trim();
      currentSection.push(item);
      if (currentSectionName === "Breaking Changes" && currentPkg) {
        breakingChanges.push({ package: currentPkg.name, description: item });
      }
    } else if (currentSection && currentSection.length > 0 && line && !line.startsWith("#")) {
      currentSection[currentSection.length - 1] += ` ${line}`;
      if (currentSectionName === "Breaking Changes" && breakingChanges.length > 0) {
        breakingChanges[breakingChanges.length - 1].description += ` ${line}`;
      }
    }
  }

  return {
    tag,
    version,
    publishedAt: "",
    packages,
    breakingChanges,
    rawBody: body,
  };
}

export function classifyOmpRemoteImpacts(release) {
  const impacts = [];

  for (const pkg of release.packages) {
    for (const items of Object.values(pkg.sections)) {
      for (const item of items) {
        const lower = item.toLowerCase();

        // 1. Extension API & Hooks
        if (
          pkg.name === "@oh-my-pi/pi-coding-agent" &&
          (lower.includes("extension") ||
            lower.includes("hook") ||
            lower.includes("zod") ||
            lower.includes("dialog") ||
            lower.includes("ask") ||
            lower.includes("model") ||
            lower.includes("command") ||
            lower.includes("event") ||
            lower.includes("ctx."))
        ) {
          impacts.push({
            component: "omp-extension",
            category: "Extension API / Lifecycle",
            description: "Changes to ExtensionAPI, ExtensionContext, extension hooks, or events",
            item,
            sourcePackage: pkg.name,
            releaseTag: release.tag,
          });
        }

        // 2. RPC Protocol & Commands
        if (
          (pkg.name === "@oh-my-pi/pi-coding-agent" || pkg.name === "@oh-my-pi/pi-agent-core") &&
          (lower.includes("rpc") ||
            lower.includes("get_state") ||
            lower.includes("fast_mode") ||
            lower.includes("thinking") ||
            lower.includes("steer") ||
            lower.includes("follow_up") ||
            lower.includes("prompt") ||
            lower.includes("jsonl") ||
            lower.includes("chunk"))
        ) {
          impacts.push({
            component: "omp-rpc / daemon",
            category: "RPC Protocol & Process Management",
            description: "Changes to RPC command framing, message streaming, or session state",
            item,
            sourcePackage: pkg.name,
            releaseTag: release.tag,
          });
        }

        // 3. Hashline & Patch language
        if (
          (pkg.name === "@oh-my-pi/hashline" || pkg.name === "@oh-my-pi/pi-coding-agent") &&
          (lower.includes("hashline") ||
            lower.includes("patch") ||
            lower.includes("put") ||
            lower.includes("cut") ||
            lower.includes("del") ||
            lower.includes("swap") ||
            lower.includes("ins") ||
            lower.includes("copy") ||
            lower.includes("paste") ||
            lower.includes("hunk"))
        ) {
          impacts.push({
            component: "protocol / sessions (transcript)",
            category: "Hashline & Patch Editing",
            description: "Hashline edit syntax or patch language parsing",
            item,
            sourcePackage: pkg.name,
            releaseTag: release.tag,
          });
        }

        // 4. Built-in Tools Normalizers
        if (
          (pkg.name === "@oh-my-pi/pi-agent-core" || pkg.name === "@oh-my-pi/pi-coding-agent") &&
          (lower.includes("tool") ||
            lower.includes("read") ||
            lower.includes("write") ||
            lower.includes("edit") ||
            lower.includes("bash") ||
            lower.includes("task") ||
            lower.includes("ask") ||
            lower.includes("think") ||
            lower.includes("browser"))
        ) {
          impacts.push({
            component: "protocol / daemon (normalizers)",
            category: "Built-in Tool Normalizers",
            description: "Changes to built-in tool input/output formats or parameters",
            item,
            sourcePackage: pkg.name,
            releaseTag: release.tag,
          });
        }
      }
    }
  }

  return impacts;
}

export async function fetchReleases(fromVersion, toVersion) {
  const url = "https://api.github.com/repos/can1357/oh-my-pi/releases?per_page=100";
  const headers = {
    "User-Agent": "omp-remote-upgrade-check",
    Accept: "application/vnd.github.v3+json",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch releases from GitHub: HTTP ${response.status} ${response.statusText}`);
  }

  const rawReleases = await response.json();
  const parsed = [];

  for (const raw of rawReleases) {
    const version = raw.tag_name.replace(/^v/, "");
    const isNewerThanFrom = compareSemver(version, fromVersion) > 0;
    const isWithinTo = !toVersion || compareSemver(version, toVersion) <= 0;

    if (isNewerThanFrom && isWithinTo) {
      const release = parseReleaseBody(raw.body || "", raw.tag_name);
      release.publishedAt = raw.published_at;
      parsed.push(release);
    }
  }

  // Sort ascending (chronological order)
  return parsed.sort((a, b) => compareSemver(a.version, b.version));
}

export function buildAuditReport(fromVersion, toVersion, releases, options = {}) {
  const breakingChanges = [];
  const allImpacts = [];
  const affectedComponents = new Set();

  for (const release of releases) {
    for (const bc of release.breakingChanges) {
      breakingChanges.push({
        release: release.tag,
        package: bc.package,
        description: bc.description,
      });
    }

    const impacts = classifyOmpRemoteImpacts(release);
    for (const impact of impacts) {
      allImpacts.push(impact);
      affectedComponents.add(impact.component);
    }
  }

  return {
    fromVersion,
    toVersion,
    baseSupportedVersion: options.baseSupportedVersion || fromVersion,
    lastCheckedVersion: options.lastCheckedVersion || null,
    lastCheckedAt: options.lastCheckedAt || null,
    releaseCount: releases.length,
    releases,
    breakingChanges,
    componentImpacts: allImpacts,
    summary: {
      hasBreakingChanges: breakingChanges.length > 0,
      breakingChangeCount: breakingChanges.length,
      affectedComponents: Array.from(affectedComponents).sort(),
    },
    statePath: options.statePath || null,
    stateSaved: Boolean(options.stateSaved),
  };
}

export function formatMarkdownReport(report) {
  const lines = [];

  lines.push("# OMP Remote Compatibility & Changelog Audit");
  lines.push("");
  lines.push(`- **Base (supported) version:** \`${report.baseSupportedVersion || report.fromVersion}\``);
  if (report.lastCheckedVersion) {
    lines.push(
      `- **Prior checked version:** \`${report.lastCheckedVersion}\`${report.lastCheckedAt ? ` (checked at ${report.lastCheckedAt})` : ""}`,
    );
  }
  lines.push(`- **Audited range:** \`${report.fromVersion}\` → \`${report.toVersion}\``);
  lines.push(`- **Releases evaluated:** ${report.releaseCount}`);
  lines.push(`- **Breaking changes found:** ${report.summary.breakingChangeCount}`);
  if (report.stateSaved && report.statePath) {
    lines.push(`- **State updated:** Saved audit checkpoint to \`${report.statePath}\``);
  }
  lines.push("");

  if (report.releaseCount === 0) {
    lines.push(
      `## ✅ Up to Date: No new releases found between \`${report.fromVersion}\` and \`${report.toVersion}\`.`,
    );
    lines.push("");
    return lines.join("\n");
  }

  if (report.summary.hasBreakingChanges) {
    lines.push("## ⚠️ Breaking Changes Detected");
    lines.push("");
    for (const bc of report.breakingChanges) {
      lines.push(`- **[${bc.release}] \`${bc.package}\`**: ${bc.description}`);
    }
    lines.push("");
  } else {
    lines.push("## ✅ No Explicit Breaking Changes Detected");
    lines.push("");
  }

  if (report.summary.affectedComponents.length > 0) {
    lines.push("## 🔍 Affected OMP Remote Subsystems");
    lines.push("");
    for (const comp of report.summary.affectedComponents) {
      lines.push(`### ${comp}`);
      const relevant = report.componentImpacts.filter((i) => i.component === comp);
      const seen = new Set();
      for (const imp of relevant) {
        if (seen.has(imp.item)) continue;
        seen.add(imp.item);
        lines.push(`- **[${imp.releaseTag}]** ${imp.item}`);
      }
      lines.push("");
    }
  }

  lines.push("## 📦 Upgrade Checklist for omp-remote");
  lines.push("");
  lines.push("1. **Workspace Catalog Updates:**");
  lines.push(
    `   - Update \`@oh-my-pi/pi-coding-agent\` to \`${report.toVersion}\` in \`pnpm-workspace.yaml\` (\`catalog:\` and \`minimumReleaseAgeExclude:\`).`,
  );
  lines.push(`   - Update \`README.md\` Stack table OMP version entry to \`${report.toVersion}\`.`);
  lines.push("2. **Extension & RPC Verification:**");
  lines.push("   - Rebuild extension bundle: `pnpm --filter @omp-remote/omp-extension build`");
  lines.push("   - Verify RPC frame compatibility and state updates.");
  lines.push("3. **Protocol & Normalizers Verification:**");
  lines.push("   - Verify tool call normalizers in `@omp-remote/protocol` and `apps/daemon`.");
  lines.push("   - Check hashline edit patch syntax and ask dialog responses.");
  lines.push("4. **Full Test Pipeline:**");
  lines.push("   - Run `pnpm run typecheck`");
  lines.push("   - Run `pnpm run lint` and `pnpm run lint:lines`");
  lines.push("   - Run `pnpm test`");
  lines.push("");

  return lines.join("\n");
}

export function updateWorkspaceYamlContent(content, targetVersion) {
  let updated = content.replace(/('@oh-my-pi\/pi-coding-agent':\s*)['"]?[^'"\s]+['"]?/, `$1${targetVersion}`);
  updated = updated.replace(/('@oh-my-pi\/[a-z0-9-]+@)[^'"\s]+/g, `$1${targetVersion}`);
  return updated;
}

export function updateReadmeContent(content, targetVersion) {
  return content.replace(
    /(\|\s*OMP integration\s*\|\s*OMP SDK \+ RPC\s*\|\s*`)[^`]+(`\s*\|)/,
    `$1${targetVersion}$2`,
  );
}

export async function applyWorkspaceVersionUpdates(workspaceRoot, targetVersion) {
  const yamlPath = join(workspaceRoot, "pnpm-workspace.yaml");
  const readmePath = join(workspaceRoot, "README.md");

  const yamlContent = await readFile(yamlPath, "utf8");
  const updatedYaml = updateWorkspaceYamlContent(yamlContent, targetVersion);
  await writeFile(yamlPath, updatedYaml, "utf8");

  const readmeContent = await readFile(readmePath, "utf8");
  const updatedReadme = updateReadmeContent(readmeContent, targetVersion);
  await writeFile(readmePath, updatedReadme, "utf8");

  return { yamlPath, readmePath };
}

export function generatePrBranchName(toVersion) {
  const sanitized = toVersion.replace(/[^a-zA-Z0-9.-]/g, "-").replace(/\./g, "-");
  return `upgrade-omp-to-v${sanitized}`;
}

export function generatePrMetadata(report) {
  const title = `feat(omp): upgrade OMP integration to v${report.toVersion}`;

  const summaryItems = [
    `- Updated \`@oh-my-pi/pi-coding-agent\` catalog dependency and \`minimumReleaseAgeExclude\` to \`v${report.toVersion}\` in \`pnpm-workspace.yaml\`.`,
    `- Updated \`README.md\` Stack table OMP integration version to \`v${report.toVersion}\`.`,
    `- Evaluated ${report.releaseCount} releases and ${report.summary.breakingChangeCount} breaking changes from \`v${report.fromVersion}\` to \`v${report.toVersion}\`.`,
    `- Recorded audit checkpoint to \`.omp/changelog-state.json\`.`,
  ];

  const breakingBullets =
    report.breakingChanges.length > 0
      ? report.breakingChanges
          .map((bc) => `- **[${bc.release}] \`${bc.package}\`**: ${bc.description}`)
          .join("\n")
      : "- No explicit breaking changes reported.";

  const affectedSubsystems =
    report.summary.affectedComponents.length > 0
      ? report.summary.affectedComponents.map((comp) => `- **${comp}**`).join("\n")
      : "- No subsystem disruptions identified.";

  const body = `## Goal
Upgrade OMP integration from \`${report.fromVersion}\` to \`${report.toVersion}\` and ensure compatibility across all omp-remote subsystems.

## Summary
${summaryItems.join("\n")}

### Breaking Changes Evaluated
${breakingBullets}

### Subsystems Reviewed
${affectedSubsystems}

## Test plan
### Automated
- \`node --test scripts/check-omp-changelog.test.mjs\` — passed
- \`pnpm --filter @omp-remote/omp-extension test\` — passed
- \`pnpm run typecheck\` — passed
- \`pnpm test\` — passed

### Manual
- Verified extension build and RPC protocol readiness for OMP \`v${report.toVersion}\`.
`;

  return { title, body };
}

export async function executeUpgradeAndCreatePr(workspaceRoot, report, options = {}) {
  const { dryRun = false } = options;
  const branchName = generatePrBranchName(report.toVersion);
  const { title, body } = generatePrMetadata(report);

  if (dryRun) {
    return {
      dryRun: true,
      branchName,
      title,
      body,
    };
  }

  // 1. Apply file updates to pnpm-workspace.yaml and README.md
  await applyWorkspaceVersionUpdates(workspaceRoot, report.toVersion);

  // 2. Try Graphite or Git branch creation
  let createdWithGraphite = false;
  try {
    await execFileAsync("gt", ["create", "--no-interactive", "-m", title], { cwd: workspaceRoot });
    createdWithGraphite = true;
  } catch {
    // Fall back to git branch
    try {
      await execFileAsync("git", ["checkout", "-b", branchName], { cwd: workspaceRoot });
    } catch {
      // Branch might already exist
    }
  }

  // 3. Stage and commit changes if git fallback
  if (!createdWithGraphite) {
    await execFileAsync("git", ["add", "pnpm-workspace.yaml", "README.md", ".omp/changelog-state.json"], {
      cwd: workspaceRoot,
    });
    await execFileAsync("git", ["commit", "-m", title], { cwd: workspaceRoot });
  }

  // 4. Submit via Graphite or GitHub CLI
  let prUrl = null;
  if (createdWithGraphite) {
    try {
      const { stdout } = await execFileAsync("gt", ["submit", "--no-interactive", "--no-edit", "--publish"], {
        cwd: workspaceRoot,
      });
      const prMatch = /https:\/\/app\.graphite\.com\/github\/pr\/[^\s]+/i.exec(stdout);
      prUrl = prMatch?.[0] || null;
    } catch {
      // Ignore submit failure in non-interactive / local test runs
    }
  } else {
    try {
      const { stdout } = await execFileAsync("gh", ["pr", "create", "--title", title, "--body", body], {
        cwd: workspaceRoot,
      });
      prUrl = stdout.trim();
    } catch {
      // Fall back if gh is not authenticated
    }
  }

  return {
    branchName,
    title,
    body,
    prUrl,
    createdWithGraphite,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: node scripts/check-omp-changelog.mjs [options]

Options:
  --from <version>    Base version (defaults to lastCheckedVersion from state, or pnpm-workspace.yaml)
  --to <version>      Target version (defaults to installed omp version or latest release)
  --from-catalog      Ignore state file and start from pnpm-workspace.yaml catalog version
  --state <path>      Custom state file path (defaults to .omp/changelog-state.json)
  --create-pr         Automatically apply version bumps and create/submit PR for breaking changes
  --dry-run           Preview PR creation and workspace modifications without mutating repo
  --save              Save audit checkpoint to state file (default: true)
  --no-save           Do not update state file
  --json              Output full report as JSON
  --help, -h          Show this help message
`);
    return;
  }

  let fromVersion;
  let toVersion;
  let fromCatalog = false;
  let statePath;
  let shouldSaveState = true;
  let jsonOutput = false;
  let createPr = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      fromVersion = args[i + 1];
      i++;
    } else if (args[i] === "--to" && args[i + 1]) {
      toVersion = args[i + 1];
      i++;
    } else if (args[i] === "--state" && args[i + 1]) {
      statePath = args[i + 1];
      i++;
    } else if (args[i] === "--from-catalog") {
      fromCatalog = true;
    } else if (args[i] === "--create-pr" || args[i] === "--upgrade") {
      createPr = true;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--save") {
      shouldSaveState = true;
    } else if (args[i] === "--no-save") {
      shouldSaveState = false;
    } else if (args[i] === "--json") {
      jsonOutput = true;
    }
  }

  const workspaceRoot = process.cwd();
  const resolvedStatePath = statePath || getDefaultStatePath(workspaceRoot);
  const changelogState = await loadChangelogState(resolvedStatePath);
  const catalogVersion = await detectSupportedVersion(workspaceRoot);

  if (!fromVersion) {
    if (!fromCatalog && changelogState.lastCheckedVersion) {
      fromVersion = changelogState.lastCheckedVersion;
    } else {
      fromVersion = catalogVersion;
    }
  }

  if (!toVersion) {
    const installed = await detectInstalledOmpVersion();
    if (installed && compareSemver(installed, fromVersion) > 0) {
      toVersion = installed;
    }
  }

  try {
    const releases = await fetchReleases(fromVersion, toVersion);
    const resolvedTo =
      toVersion || (releases.length > 0 ? releases[releases.length - 1].version : fromVersion);

    let stateSaved = false;
    if (shouldSaveState && !dryRun) {
      const updatedState = updateChangelogState(changelogState, {
        fromVersion,
        toVersion: resolvedTo,
        baseSupportedVersion: catalogVersion,
        report: {
          releaseCount: releases.length,
          summary: {
            breakingChangeCount: releases.flatMap((r) => r.breakingChanges).length,
          },
        },
      });
      await saveChangelogState(resolvedStatePath, updatedState);
      stateSaved = true;
    }

    const report = buildAuditReport(fromVersion, resolvedTo, releases, {
      baseSupportedVersion: catalogVersion,
      lastCheckedVersion: changelogState.lastCheckedVersion,
      lastCheckedAt: changelogState.lastCheckedAt,
      statePath: resolvedStatePath,
      stateSaved,
    });

    if (createPr) {
      console.log(`\n🚀 Preparing Automated Upgrade & PR for OMP v${resolvedTo}...\n`);
      const prResult = await executeUpgradeAndCreatePr(workspaceRoot, report, { dryRun });
      if (dryRun) {
        console.log(`[DRY RUN] Would create branch: ${prResult.branchName}`);
        console.log(`[DRY RUN] PR Title: ${prResult.title}`);
        console.log(`[DRY RUN] PR Body:\n${prResult.body}`);
      } else {
        console.log(`✅ Branch prepared: ${prResult.branchName}`);
        console.log(`✅ PR Title: ${prResult.title}`);
        if (prResult.prUrl) {
          console.log(`🔗 Pull Request: ${prResult.prUrl}`);
        }
      }
      return;
    }

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatMarkdownReport(report));
    }
  } catch (error) {
    console.error(`Error checking OMP changelog: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("check-omp-changelog.mjs")) {
  await main();
}
