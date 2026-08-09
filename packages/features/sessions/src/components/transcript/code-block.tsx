import { memo, useMemo } from "react";
import { classifyDiffLine, parseTranscriptBlocks, type DiffLine } from "./blocks.js";
import { tokenizeCode } from "./code-tokenizer.js";
import { TranscriptProse } from "./inline-transcript.js";
import { cn } from "../ui/utils.js";

const HighlightedCode = memo(function HighlightedCode({
  code,
  language,
}: {
  code: string;
  language: string | null;
}) {
  const tokens = useMemo(() => tokenizeCode(code, language), [code, language]);
  return (
    <code>
      {tokens.map((token, index) => (
        <span className={`syntax-${token.kind}`} key={`${index}:${token.kind}`}>
          {token.text}
        </span>
      ))}
    </code>
  );
});

export function TranscriptCodeBlock({ code, language }: { code: string; language: string | null }) {
  return (
    <details className="transcript-disclosure-frame code-block">
      <summary>
        <span className="code-block-chevron" aria-hidden="true" />
        <span>{language ?? "code"}</span>
        <span className="code-block-action">
          <span className="code-block-action-collapsed">Show code</span>
          <span className="code-block-action-expanded">Hide code</span>
        </span>
      </summary>
      <pre>
        <HighlightedCode code={code} language={language} />
      </pre>
    </details>
  );
}

export function TranscriptDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="transcript-message-diff">
      {lines.map((line, index) => (
        <span className={cn("diff-line", `diff-${line.kind}`)} key={`${index}:${line.kind}`}>
          {line.text}
        </span>
      ))}
    </div>
  );
}

const SYSTEM_TEXT_PREVIEW_LENGTH = 180;

export function formatSystemTextPreview(text: string): string {
  const preview = text
    .slice(0, SYSTEM_TEXT_PREVIEW_LENGTH + 1)
    .replace(/\s+/g, " ")
    .trim();
  if (!preview) return "System message";
  if (text.length <= SYSTEM_TEXT_PREVIEW_LENGTH) return preview;
  return `${preview.slice(0, SYSTEM_TEXT_PREVIEW_LENGTH).trimEnd()}…`;
}

export const TranscriptText = memo(function TranscriptText({ text }: { text: string }) {
  const blocks = useMemo(() => parseTranscriptBlocks(text), [text]);

  return (
    <div className="transcript-message">
      {blocks.map((block, index) => {
        if (block.kind === "text") {
          return <TranscriptProse key={`${index}:text`} text={block.text} />;
        }
        if (block.kind === "code") {
          return <TranscriptCodeBlock code={block.text} key={`${index}:code`} language={block.language} />;
        }
        return <TranscriptDiff key={`${index}:diff`} lines={block.lines} />;
      })}
    </div>
  );
});

export { classifyDiffLine };
