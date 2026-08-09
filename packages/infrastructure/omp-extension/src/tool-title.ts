export type ExtensionToolDetails = {
  diff?: unknown;
  path?: unknown;
  resolvedPath?: unknown;
  meta?: { source?: { value?: unknown } };
  perFileResults?: unknown[];
  matchCount?: unknown;
  fileCount?: unknown;
  scopePath?: unknown;
  to?: unknown;
  receipts?: unknown;
  waited?: unknown;
};

export function formatExtensionToolTitle(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
  details: ExtensionToolDetails | undefined,
  canonicalDiff: string | undefined,
): string | undefined {
  if (toolName === "bash") {
    const command = normalizeHeaderValue(args?.command);
    return command ? `Bash: ${command}` : undefined;
  }
  if (toolName === "write") {
    const path = normalizeBoundedSingleLine(args?.path);
    return path ? `Write: ${path}` : undefined;
  }
  if (toolName === "edit") {
    const inputPaths = extractEditPaths(args?.input);
    const perFilePaths = Array.isArray(details?.perFileResults)
      ? details.perFileResults
          .map((result) =>
            typeof result === "object" && result !== null && "path" in result
              ? normalizeBoundedSingleLine(result.path)
              : undefined,
          )
          .filter((path): path is string => Boolean(path))
      : [];
    const detailPath = normalizeBoundedSingleLine(details?.path);
    const paths = inputPaths.length > 0 ? inputPaths : [...perFilePaths, ...(detailPath ? [detailPath] : [])];
    const pathLabel =
      paths.length === 0 ? null : `${paths[0]}${paths.length > 1 ? ` +${paths.length - 1} more` : ""}`;
    const changes = canonicalDiff ? countDiffChanges(canonicalDiff) : null;
    const changeLabel = changes
      ? [
          changes.added > 0 ? `⟦+${changes.added}⟧` : null,
          changes.removed > 0 ? `⟦−${changes.removed}⟧` : null,
        ]
          .filter(Boolean)
          .join(" ")
      : "";
    return pathLabel ? `Edit: 🟦 ${pathLabel}${changeLabel ? ` ${changeLabel}` : ""}` : undefined;
  }
  if (toolName === "grep") {
    const pattern = normalizeHeaderValue(args?.pattern);
    if (!pattern) return undefined;
    const matchCount =
      typeof details?.matchCount === "number" &&
      Number.isInteger(details.matchCount) &&
      details.matchCount >= 0
        ? details.matchCount
        : undefined;
    const fileCount =
      typeof details?.fileCount === "number" && Number.isInteger(details.fileCount) && details.fileCount >= 0
        ? details.fileCount
        : undefined;
    const rawScope = normalizeBoundedSingleLine(args?.path) ?? normalizeBoundedSingleLine(details?.scopePath);
    const scope = rawScope
      ?.split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(", ");
    const countLabel =
      matchCount === undefined || fileCount === undefined
        ? ""
        : ` ${matchCount} ${matchCount === 1 ? "match" : "matches"} · ${fileCount} ${
            fileCount === 1 ? "file" : "files"
          }`;
    return `Grep: ${pattern}${countLabel}${scope ? ` · in ${scope}` : ""}`;
  }
  if (toolName === "hub") {
    const waited = details?.waited;
    const incomingFrom =
      typeof waited === "object" && waited !== null && "from" in waited
        ? normalizeHeaderValue(waited.from)
        : undefined;
    if (incomingFrom) return `✉ IRC ⟵ ${incomingFrom}`;

    if (args?.op !== "send") return undefined;
    const target = normalizeHeaderValue(args.to) ?? normalizeHeaderValue(details?.to);
    if (!target) return undefined;
    const receipt = Array.isArray(details?.receipts)
      ? details.receipts.find(
          (candidate) =>
            typeof candidate === "object" &&
            candidate !== null &&
            "to" in candidate &&
            candidate.to === target,
        )
      : undefined;
    const outcome =
      typeof receipt === "object" && receipt !== null && "outcome" in receipt
        ? normalizeIrcOutcome(receipt.outcome)
        : undefined;
    return `IRC ➤ ${target}${outcome ? ` ${outcome}` : ""}`;
  }
  return undefined;
}

function extractEditPaths(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const paths: string[] = [];
  const patterns = [/^\[([^#\r\n]+)#[\dA-Fa-f]{4}\]$/gm, /^\*\*\* (?:Add|Delete|Update) File:\s*(.+)$/gm];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const path = normalizeBoundedSingleLine(match[1]);
      if (path && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

function countDiffChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r\n|\n|\r/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function normalizeBoundedSingleLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 10_000 && !/[\0\r\n]/.test(normalized) ? normalized : undefined;
}

function normalizeHeaderValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= 10_000 ? normalized : undefined;
}

function normalizeIrcOutcome(value: unknown): string | undefined {
  return value === "injected" || value === "woken" || value === "revived" || value === "failed"
    ? value
    : undefined;
}
