import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_LINES = 1_000;
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".css"]);
const EXCLUDED_DIRECTORIES = new Set([".pnpm-store", ".turbo", "coverage", "dist", "node_modules"]);
const GENERATED_LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

function isGeneratedWebAsset(path) {
  return path === "apps/web/public/sw.js" || /^apps\/web\/public\/workbox-[^/]+\.js$/.test(path);
}

function shouldCheck(path) {
  const segments = path.split("/");
  const basename = segments.at(-1);

  return (
    SOURCE_EXTENSIONS.has(extname(path)) &&
    !segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment)) &&
    !GENERATED_LOCKFILES.has(basename) &&
    !isGeneratedWebAsset(path)
  );
}

function countLines(contents) {
  if (contents.length === 0) return 0;

  let lines = contents.endsWith("\n") ? 0 : 1;
  for (const character of contents) {
    if (character === "\n") lines += 1;
  }
  return lines;
}

async function trackedPaths() {
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "-z"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function main() {
  const violations = [];

  for (const path of await trackedPaths()) {
    if (!shouldCheck(path)) continue;

    const contents = await readFile(path, "utf8");
    if (contents.includes("\0")) continue;

    const lines = countLines(contents);
    if (lines > MAX_LINES) violations.push({ path, lines });
  }

  if (violations.length === 0) {
    console.log(`All tracked source files are within ${MAX_LINES} lines.`);
    return;
  }

  console.error(`Tracked source files must not exceed ${MAX_LINES} lines:`);
  for (const { path, lines } of violations) console.error(`${path}: ${lines} lines`);
  process.exitCode = 1;
}

await main();
