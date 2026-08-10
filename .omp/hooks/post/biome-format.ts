interface ToolResultEvent {
  toolName: string;
  input: Record<string, unknown>;
  content: unknown[];
  isError?: boolean;
}

interface HookAPI {
  on(
    event: "tool_result",
    handler: (
      event: ToolResultEvent,
      context: { cwd: string },
    ) => Promise<{ content: unknown[] } | undefined>,
  ): void;
  exec(
    command: string,
    args: string[],
    options: { cwd: string; timeout: number },
  ): Promise<{ stdout: string; stderr: string; code: number }>;
  logger: { warn(message: string): void };
}

const EDIT_PATH_PATTERN = /^\[([^#\r\n]+)#[0-9A-F]{4}\]$/gm;
const FORMAT_TIMEOUT_MS = 120_000;

function changedPaths(event: ToolResultEvent): string[] {
  if (event.toolName === "write") {
    return typeof event.input.path === "string" ? [event.input.path] : [];
  }
  if (event.toolName !== "edit") return [];

  const paths = typeof event.input.path === "string" ? [event.input.path] : [];
  for (const value of Object.values(event.input)) {
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(EDIT_PATH_PATTERN)) {
      if (match[1]) paths.push(match[1]);
    }
  }
  return paths;
}

function projectFiles(paths: readonly string[], cwd: string): string[] {
  const root = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  const files = new Set<string>();
  for (const path of paths) {
    if (path.includes("://")) continue;

    const normalizedPath = path.replaceAll("\\", "/");
    let projectPath = normalizedPath;
    if (/^(?:\/|[A-Za-z]:\/)/.test(normalizedPath)) {
      if (!normalizedPath.startsWith(`${root}/`)) continue;
      projectPath = normalizedPath.slice(root.length + 1);
    }

    const segments: string[] = [];
    let escapesProject = false;
    for (const segment of projectPath.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (segments.length === 0) {
          escapesProject = true;
          break;
        }
        segments.pop();
        continue;
      }
      segments.push(segment);
    }
    if (!escapesProject && segments.length > 0) files.add(segments.join("/"));
  }
  return [...files];
}

export default function biomeFormatHook(pi: HookAPI): void {
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;

    const paths = projectFiles(changedPaths(event), ctx.cwd);
    if (paths.length === 0) return;

    try {
      const result = await pi.exec(
        "pnpm",
        [
          "exec",
          "biome",
          "format",
          "--write",
          "--files-ignore-unknown=true",
          "--no-errors-on-unmatched",
          ...paths,
        ],
        { cwd: ctx.cwd, timeout: FORMAT_TIMEOUT_MS },
      );
      if (result.code === 0) return;

      const detail = result.stderr.trim() || result.stdout.trim() || "No formatter output.";
      const message = `Biome format failed with exit code ${result.code}:\n${detail}`;
      pi.logger.warn(message);
      return {
        content: [...event.content, { type: "text", text: message }],
      };
    } catch (error) {
      const message = `Biome format failed to start: ${error instanceof Error ? error.message : String(error)}`;
      pi.logger.warn(message);
      return {
        content: [...event.content, { type: "text", text: message }],
      };
    }
  });
}
