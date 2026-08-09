export type InlineTranscriptToken =
  | { kind: "text" | "strong" | "code"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE_MARKUP_PATTERN =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>"'`\\]+)/g;
const ABSOLUTE_HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`\\]+/gi;
const URL_TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}
function hasSafeUrlBoundary(text: string, start: number): boolean {
  return start === 0 || /[\s("'`[{<]/.test(text[start - 1] ?? "");
}

function trimUrlCandidate(value: string): { href: string; trailing: string } {
  let href = value;
  let trailing = "";

  const punctuation = href.match(URL_TRAILING_PUNCTUATION)?.[0] ?? "";
  if (punctuation) {
    href = href.slice(0, -punctuation.length);
    trailing = punctuation + trailing;
  }

  for (const [opening, closing] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    while (href.endsWith(closing)) {
      const openingCount = [...href].filter((character) => character === opening).length;
      const closingCount = [...href].filter((character) => character === closing).length;
      if (closingCount <= openingCount) break;
      href = href.slice(0, -1);
      trailing = closing + trailing;
    }
  }

  return { href, trailing };
}

function tokenizeSafeHttpUrls(text: string): InlineTranscriptToken[] {
  const tokens: InlineTranscriptToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(ABSOLUTE_HTTP_URL_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    const { href, trailing } = trimUrlCandidate(raw);
    if (!href || !isSafeHttpUrl(href) || !hasSafeUrlBoundary(text, start)) continue;
    if (start < cursor) continue;
    if (start > cursor) tokens.push({ kind: "text", text: text.slice(cursor, start) });
    tokens.push({ kind: "link", text: href, href });
    if (trailing) tokens.push({ kind: "text", text: trailing });
    cursor = start + raw.length;
  }

  if (cursor < text.length) tokens.push({ kind: "text", text: text.slice(cursor) });
  return tokens.length > 0 ? tokens : [{ kind: "text", text }];
}

function pushLiteralTextToken(tokens: InlineTranscriptToken[], text: string) {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.kind === "text") {
    previous.text += text;
  } else {
    tokens.push({ kind: "text", text });
  }
}

function pushSafeHttpTokens(tokens: InlineTranscriptToken[], text: string) {
  for (const token of tokenizeSafeHttpUrls(text)) {
    if (token.kind === "text") {
      pushLiteralTextToken(tokens, token.text);
    } else {
      tokens.push(token);
    }
  }
}

export function parseInlineTranscript(text: string): InlineTranscriptToken[] {
  const tokens: InlineTranscriptToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_MARKUP_PATTERN)) {
    const start = match.index;
    if (start < cursor) continue;
    if (start > cursor) pushSafeHttpTokens(tokens, text.slice(cursor, start));

    const raw = match[0];
    if (raw.startsWith("`")) {
      tokens.push({ kind: "code", text: raw.slice(1, -1) });
    } else if (raw.startsWith("**")) {
      tokens.push({ kind: "strong", text: raw.slice(2, -2) });
    } else if (raw.startsWith("[")) {
      const labelEnd = raw.indexOf("](");
      tokens.push({
        kind: "link",
        text: raw.slice(1, labelEnd),
        href: raw.slice(labelEnd + 2, -1),
      });
    } else {
      const { href, trailing } = trimUrlCandidate(raw);
      if (!isSafeHttpUrl(href) || !hasSafeUrlBoundary(text, start)) {
        pushLiteralTextToken(tokens, raw);
      } else {
        tokens.push({ kind: "link", text: href, href });
        if (trailing) tokens.push({ kind: "text", text: trailing });
      }
    }
    cursor = start + raw.length;
  }

  if (cursor < text.length) pushSafeHttpTokens(tokens, text.slice(cursor));
  return tokens.length > 0 ? tokens : [{ kind: "text", text }];
}

export { tokenizeSafeHttpUrls };
