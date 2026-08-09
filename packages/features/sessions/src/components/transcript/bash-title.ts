export type BashTitleTokenKind = "plain" | "word" | "operator" | "option" | "string";

export type BashTitleToken = {
  kind: BashTitleTokenKind;
  text: string;
};

const BASH_TITLE_OPERATORS = [
  "&>>",
  "<<<",
  ">>>",
  ";;&",
  ">&",
  "<&",
  ";&",
  "&&",
  "||",
  ">>",
  "<<",
  "<>",
  ">|",
  "|&",
  "&>",
  ";;",
  "(",
  ")",
  ";",
  "|",
  "&",
  ">",
  "<",
] as const;

type BashTitleTokenPart = { kind: "word" | "string"; text: string };
const BASH_TITLE_INCOMPLETE_OPERATORS: Record<string, true> = {
  "&&": true,
  "||": true,
  "<<<": true,
  ">>": true,
  "<<": true,
  "<>": true,
  ">|": true,
  "|&": true,
  "&>": true,
  "&>>": true,
  ">&": true,
  "<&": true,
  "|": true,
  ">": true,
  "<": true,
  "(": true,
  "!": true,
};

function bashTitleOperatorAt(text: string, index: number): string | null {
  for (const operator of BASH_TITLE_OPERATORS) {
    if (text.startsWith(operator, index)) return operator;
  }
  return null;
}

const BASH_TITLE_REDIRECTION_OPERATORS: Record<string, true> = {
  "&>>": true,
  "<<<": true,
  ">>": true,
  "<<": true,
  "<>": true,
  ">|": true,
  "&>": true,
  ">&": true,
  "<&": true,
  ">": true,
  "<": true,
};
const BASH_TITLE_MALFORMED_OPERATORS: Record<string, true> = {
  ">>>": true,
};
const BASH_TITLE_COMMAND_PREFIX_OPERATORS: Record<string, true> = {
  "&&": true,
  "||": true,
  "|": true,
  "|&": true,
  ";": true,
  ";;": true,
  ";&": true,
  ";;&": true,
  "(": true,
  "!": true,
};
const BASH_TITLE_BINARY_OPERATORS: Record<string, true> = {
  "&&": true,
  "||": true,
  "|": true,
  "|&": true,
};
const BASH_TITLE_COMMAND_PREFIX_WORDS: Record<string, true> = {
  if: true,
  elif: true,
  else: true,
  while: true,
  until: true,
  do: true,
  time: true,
  coproc: true,
  "{": true,
};

function previousSignificantBashTitleToken(tokens: readonly BashTitleToken[]): BashTitleToken | undefined {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.kind !== "plain" || !/^\s*$/.test(token.text)) return token;
  }
  return undefined;
}

/**
 * Tokenizes the suffix of a normalized Bash tool title without changing its text.
 * A recognized incomplete or malformed streaming shell fragment is intentionally left unstyled.
 */
export function tokenizeBashTitle(text: string): BashTitleToken[] {
  const tokens: BashTitleToken[] = [];
  let parts: BashTitleTokenPart[] = [];
  let wordHasContent = false;
  let optionWord = false;

  const flushWord = () => {
    if (parts.length === 0) return;
    if (optionWord) {
      tokens.push({ kind: "option", text: parts.map((part) => part.text).join("") });
    } else {
      for (const part of parts) {
        const previous = tokens[tokens.length - 1];
        if (part.kind === "word" && previous?.kind === "word") {
          previous.text += part.text;
        } else {
          tokens.push({ kind: part.kind, text: part.text });
        }
      }
    }
    parts = [];
    wordHasContent = false;
    optionWord = false;
  };

  const plainFallback = () => [{ kind: "plain" as const, text }];

  let index = 0;
  let parenthesisDepth = 0;
  while (index < text.length) {
    const character = text.charAt(index);
    if (/\s/.test(character)) {
      flushWord();
      const start = index;
      do {
        index += 1;
      } while (index < text.length && /\s/.test(text.charAt(index)));
      tokens.push({ kind: "plain", text: text.slice(start, index) });
      continue;
    }

    const previousToken = previousSignificantBashTitleToken(tokens);
    const bangOperator =
      character === "!" &&
      !wordHasContent &&
      parts.length === 0 &&
      (index + 1 === text.length || /\s/.test(text.charAt(index + 1))) &&
      (!previousToken ||
        (previousToken.kind === "operator" && BASH_TITLE_COMMAND_PREFIX_OPERATORS[previousToken.text]) ||
        (previousToken.kind === "word" &&
          (previousToken.text === "then" || BASH_TITLE_COMMAND_PREFIX_WORDS[previousToken.text])));
    let operator = bangOperator ? "!" : bashTitleOperatorAt(text, index);
    let operatorStart = index;
    if (!operator && !wordHasContent && parts.length === 0 && /\d/.test(character)) {
      let descriptorEnd = index + 1;
      while (descriptorEnd < text.length && /\d/.test(text.charAt(descriptorEnd))) descriptorEnd += 1;
      const descriptorOperator = bashTitleOperatorAt(text, descriptorEnd);
      if (descriptorOperator && BASH_TITLE_REDIRECTION_OPERATORS[descriptorOperator]) {
        operator = descriptorOperator;
        operatorStart = descriptorEnd;
      }
    }
    if (operator) {
      if (BASH_TITLE_MALFORMED_OPERATORS[operator]) return plainFallback();
      if (
        BASH_TITLE_BINARY_OPERATORS[operator] &&
        !wordHasContent &&
        (!previousToken ||
          (previousToken.kind === "operator" &&
            previousToken.text !== ")" &&
            !/^(?:\d+)?[<>]&(?:\d+|-)$/.test(previousToken.text)))
      ) {
        return plainFallback();
      }
      flushWord();
      if (operator === "(") {
        parenthesisDepth += 1;
      } else if (operator === ")") {
        if (parenthesisDepth === 0) return plainFallback();
        parenthesisDepth -= 1;
      }
      let operatorEnd = operatorStart + operator.length;
      if (operator === ">&" || operator === "<&") {
        if (/\d/.test(text.charAt(operatorEnd))) {
          do {
            operatorEnd += 1;
          } while (operatorEnd < text.length && /\d/.test(text.charAt(operatorEnd)));
        } else if (text.charAt(operatorEnd) === "-") {
          operatorEnd += 1;
        }
      }
      tokens.push({ kind: "operator", text: text.slice(index, operatorEnd) });
      index = operatorEnd;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      const start = index;
      let nestedQuote: "'" | '"' | "`" | null = null;
      let quotedSubstitutionDepth = 0;
      let closed = false;
      index += 1;
      while (index < text.length) {
        const current = text.charAt(index);
        if (nestedQuote) {
          if (current === nestedQuote) {
            nestedQuote = null;
            index += 1;
            continue;
          }
          if (nestedQuote !== "'" && current === "\\") {
            if (index + 1 >= text.length) return plainFallback();
            index += 2;
            continue;
          }
          index += 1;
          continue;
        }
        if (quote !== "'" && current === "\\") {
          if (index + 1 >= text.length) return plainFallback();
          index += 2;
          continue;
        }
        if (quote !== "'" && current === "$" && text.charAt(index + 1) === "(") {
          quotedSubstitutionDepth += 1;
          index += 2;
          continue;
        }
        if (quotedSubstitutionDepth > 0) {
          if (current === "(") quotedSubstitutionDepth += 1;
          else if (current === ")") quotedSubstitutionDepth -= 1;
          else if (current === "'" || current === '"' || current === "`") nestedQuote = current;
          index += 1;
          continue;
        }
        if (current === quote) {
          closed = true;
          index += 1;
          break;
        }
        if (quote === '"' && current === "`") nestedQuote = "`";
        index += 1;
      }
      if (!closed || quotedSubstitutionDepth > 0 || nestedQuote) return plainFallback();
      parts.push({ kind: "string", text: text.slice(start, index) });
      wordHasContent = true;
      continue;
    }

    if (character === "\\") {
      if (index + 1 >= text.length) return plainFallback();
      const start = index;
      index += 2;
      parts.push({ kind: "word", text: text.slice(start, index) });
      wordHasContent = true;
      continue;
    }

    const start = index;
    while (index < text.length) {
      const current = text.charAt(index);
      if (/\s/.test(current) || current === "'" || current === '"' || current === "`" || current === "\\") {
        break;
      }
      if (bashTitleOperatorAt(text, index)) break;
      index += 1;
    }
    if (index === start) {
      index += 1;
      parts.push({ kind: "word", text: character });
    } else {
      parts.push({ kind: "word", text: text.slice(start, index) });
    }
    if (!wordHasContent && (character === "-" || character === "+")) optionWord = true;
    wordHasContent = true;
  }
  flushWord();
  if (parenthesisDepth > 0) return plainFallback();
  for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex -= 1) {
    const token = tokens[tokenIndex];
    if (!token) continue;
    if (token.kind === "plain" && /^\s*$/.test(token.text)) continue;
    if (token.kind === "operator" && BASH_TITLE_INCOMPLETE_OPERATORS[token.text.replace(/^\d+/, "")]) {
      return plainFallback();
    }
    break;
  }
  return tokens;
}
