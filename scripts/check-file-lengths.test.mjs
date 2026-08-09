import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const checkerPath = fileURLToPath(new URL("./check-file-lengths.mjs", import.meta.url));

function fileWithLines(count) {
  return "line\n".repeat(count);
}

async function writeFiles(directory, files) {
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
}

async function createRepository({ tracked = {}, forceTracked = {}, untracked = {} }) {
  const directory = await mkdtemp(join(tmpdir(), "omp-remote-file-lengths-test-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
  await writeFiles(directory, tracked);
  await execFileAsync("git", ["add", "--all"], { cwd: directory });

  const forcedPaths = Object.keys(forceTracked);
  if (forcedPaths.length > 0) {
    await writeFiles(directory, forceTracked);
    await execFileAsync("git", ["add", "--force", "--", ...forcedPaths], { cwd: directory });
  }

  await writeFiles(directory, untracked);
  return directory;
}

async function runChecker(directory) {
  return execFileAsync(process.execPath, [checkerPath], { cwd: directory });
}

test("accepts a tracked source file at the 1000-line boundary", async (t) => {
  const directory = await createRepository({
    tracked: {
      "boundary.ts": fileWithLines(1_000),
    },
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await runChecker(directory);

  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "All tracked source files are within 1000 lines.\n");
});

test("reports every oversized tracked source file in deterministic order and exits nonzero", async (t) => {
  const directory = await createRepository({
    tracked: {
      "z.ts": fileWithLines(1_002),
      "nested/b.css": fileWithLines(1_003),
      "a.js": fileWithLines(1_001),
    },
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(runChecker(directory), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.equal(
      error.stderr,
      "Tracked source files must not exceed 1000 lines:\n" +
        "a.js: 1001 lines\n" +
        "nested/b.css: 1003 lines\n" +
        "z.ts: 1002 lines\n",
    );
    return true;
  });
});

test("excludes untracked files, ignored output and dependencies, lockfiles, and binary assets", async (t) => {
  const oversized = fileWithLines(1_001);
  const directory = await createRepository({
    tracked: {
      ".gitignore": "ignored.ts\n",
      "package-lock.json": oversized,
      "public/image.png": Buffer.alloc(2_048, 1),
      "public/runtime.js": Buffer.concat([Buffer.from([0]), Buffer.from(oversized)]),
      "small.tsx": "export const value = 1;\n",
    },
    forceTracked: {
      ".pnpm-store/package.cjs": oversized,
      ".turbo/cache.mjs": oversized,
      "apps/web/public/sw.js": oversized,
      "apps/web/public/workbox-test.js": oversized,
      "coverage/report.css": oversized,
      "dist/bundle.js": oversized,
      "node_modules/dependency.ts": oversized,
    },
    untracked: {
      "ignored.ts": oversized,
    },
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await runChecker(directory);

  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "All tracked source files are within 1000 lines.\n");
});
