type DiffLineKind = "meta" | "context" | "removed" | "added";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
};

export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; language: string | null }
  | { kind: "diff"; lines: DiffLine[] };

const DIFF_META_PATTERN =
  /^(?:diff --git |index |--- |\+\+\+ |@@ |new file mode |deleted file mode |similarity index |rename from |rename to |Binary files |\\ No newline at end of file)/;

export function classifyDiffLine(line: string): DiffLine {
  if (DIFF_META_PATTERN.test(line)) return { kind: "meta", text: line };
  if (line.startsWith("+")) return { kind: "added", text: line };
  if (line.startsWith("-")) return { kind: "removed", text: line };
  return { kind: "context", text: line };
}

function startsRawDiff(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("@@ ") ||
    (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ") === true)
  );
}

function continuesRawDiff(line: string): boolean {
  return line === "" || DIFF_META_PATTERN.test(line) || /^[ +\-]/.test(line);
}

export function parseTranscriptBlocks(text: string): TranscriptBlock[] {
  const sourceLines = text.split("\n");
  const blocks: TranscriptBlock[] = [];
  let textLines: string[] = [];
  let index = 0;

  const flushText = () => {
    if (textLines.length === 0) return;
    blocks.push({ kind: "text", text: textLines.join("\n") });
    textLines = [];
  };

  while (index < sourceLines.length) {
    const line = sourceLines[index] ?? "";
    const fence = line.match(/^```([A-Za-z0-9_+#.-]*)\s*$/);

    if (fence) {
      flushText();
      const language = fence[1] || null;
      const normalizedLanguage = language?.toLowerCase();
      const codeLines: string[] = [];
      index += 1;
      while (index < sourceLines.length && !/^```\s*$/.test(sourceLines[index] ?? "")) {
        codeLines.push(sourceLines[index] ?? "");
        index += 1;
      }
      if (index < sourceLines.length) index += 1;

      if (normalizedLanguage === "diff" || normalizedLanguage === "patch") {
        blocks.push({ kind: "diff", lines: codeLines.map(classifyDiffLine) });
      } else {
        blocks.push({ kind: "code", text: codeLines.join("\n"), language });
      }
      continue;
    }

    if (startsRawDiff(sourceLines, index)) {
      flushText();
      const diffLines: DiffLine[] = [];
      while (index < sourceLines.length) {
        const diffLine = sourceLines[index] ?? "";
        if (diffLines.length > 0 && !continuesRawDiff(diffLine)) break;
        diffLines.push(classifyDiffLine(diffLine));
        index += 1;
      }
      blocks.push({ kind: "diff", lines: diffLines });
      continue;
    }

    textLines.push(line);
    index += 1;
  }

  flushText();
  return blocks;
}
