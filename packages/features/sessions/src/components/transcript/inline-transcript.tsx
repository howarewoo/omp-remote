import { type MouseEvent as ReactMouseEvent, memo, useMemo } from "react";
import { parseInlineTranscript, tokenizeSafeHttpUrls, type InlineTranscriptToken } from "./inline-markup.js";

export function renderSafeHttpText(
  text: string,
  keyPrefix: string,
  onLinkClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void,
) {
  return tokenizeSafeHttpUrls(text).map((token, index) =>
    token.kind === "link" ? (
      <a
        className="transcript-link"
        href={token.href}
        key={`${keyPrefix}:${index}:link`}
        onClick={onLinkClick}
        rel="noreferrer"
        target="_blank"
      >
        {token.text}
      </a>
    ) : (
      <span key={`${keyPrefix}:${index}:text`}>{token.text}</span>
    ),
  );
}

export function renderSafeHttpTextWithoutLinks(text: string, keyPrefix: string) {
  return tokenizeSafeHttpUrls(text).map((token, index) =>
    token.kind === "text" ? <span key={`${keyPrefix}:${index}:text`}>{token.text}</span> : null,
  );
}

export function renderSafeHttpLinkSiblings(text: string, keyPrefix: string) {
  return tokenizeSafeHttpUrls(text)
    .filter((token): token is Extract<InlineTranscriptToken, { kind: "link" }> => token.kind === "link")
    .map((token, index) => (
      <a
        className="transcript-link"
        href={token.href}
        key={`${keyPrefix}:${index}:link`}
        onClick={(event) => event.stopPropagation()}
        rel="noreferrer"
        target="_blank"
      >
        {token.text}
      </a>
    ));
}

export function renderPlainTextWithLinks(
  text: string,
  keyPrefix: string,
  className = "transcript-disclosure-text",
  onLinkClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void,
  elementKey?: string,
) {
  return (
    <pre className={className} key={elementKey}>
      {renderSafeHttpText(text, keyPrefix, onLinkClick)}
    </pre>
  );
}

const InlineTranscript = memo(function InlineTranscript({ text }: { text: string }) {
  const tokens = useMemo(() => parseInlineTranscript(text), [text]);

  return tokens.map((token, index) => {
    if (token.kind === "link") {
      return (
        <a
          className="transcript-link"
          href={token.href}
          key={`${index}:link`}
          rel="noreferrer"
          target="_blank"
        >
          {token.text}
        </a>
      );
    }
    if (token.kind === "code") {
      return <code key={`${index}:code`}>{token.text}</code>;
    }
    if (token.kind === "strong") {
      return <strong key={`${index}:strong`}>{renderSafeHttpText(token.text, `${index}:strong`)}</strong>;
    }
    return <span key={`${index}:text`}>{token.text}</span>;
  });
});

export const TranscriptProse = memo(function TranscriptProse({ text }: { text: string }) {
  const lines = useMemo(() => {
    if (!text) {
      return [];
    }
    const rawLines = text.replace(/\r\n|\r/g, "\n").split("\n");
    let startIndex = 0;
    while (startIndex < rawLines.length && (rawLines[startIndex]?.trim() ?? "") === "") {
      startIndex++;
    }
    let endIndex = rawLines.length - 1;
    while (endIndex >= startIndex && (rawLines[endIndex]?.trim() ?? "") === "") {
      endIndex--;
    }

    if (startIndex > endIndex) {
      return [];
    }

    const result: string[] = [];
    let lastWasEmpty = false;

    for (let i = startIndex; i <= endIndex; i++) {
      const line = rawLines[i] ?? "";
      const isEmpty = line.trim() === "";
      if (isEmpty) {
        if (!lastWasEmpty) {
          result.push("");
          lastWasEmpty = true;
        }
      } else {
        result.push(line);
        lastWasEmpty = false;
      }
    }

    return result;
  }, [text]);

  return (
    <div className="transcript-prose">
      {lines.map((line, index) => {
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
          const [, marks = "", content = ""] = heading;
          return (
            <span className="transcript-heading" data-level={marks.length} key={`${index}:heading`}>
              <InlineTranscript text={content} />
            </span>
          );
        }

        const quote = line.match(/^>\s?(.*)$/);
        if (quote) {
          const [, content = ""] = quote;
          return (
            <span className="transcript-quote" key={`${index}:quote`}>
              <InlineTranscript text={content} />
            </span>
          );
        }

        const listItem = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
        if (listItem) {
          const [, indent = "", marker = "", content = ""] = listItem;
          return (
            <span
              className="transcript-list-item"
              key={`${index}:list`}
              style={{ paddingInlineStart: `${Math.floor(indent.length / 2)}rem` }}
            >
              <i aria-hidden="true">{/^\d/.test(marker) ? marker : "•"}</i>
              <span>
                <InlineTranscript text={content} />
              </span>
            </span>
          );
        }

        if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
          return <span aria-hidden="true" className="transcript-rule" key={`${index}:rule`} />;
        }

        if (!line || line.trim() === "") {
          return (
            <span
              aria-hidden="true"
              className="transcript-line transcript-line-empty"
              key={`${index}:empty`}
            />
          );
        }
        return (
          <span className="transcript-line" key={`${index}:line`}>
            <InlineTranscript text={line} />
          </span>
        );
      })}
    </div>
  );
});
