import type { AskRequest, AskResponse } from "@omp-remote/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AskToolCall } from "./dashboard.js";

const request: Extract<AskRequest, { kind: "rich" }> = {
  sessionId: "session-1",
  requestId: "request-1",
  kind: "rich",
  expiresAt: null,
  questions: [
    {
      id: "question-1",
      question: "Choose an installation option",
      options: [
        {
          label: "Install recommended https://example.com/install",
          description: "Use the docs https://example.com/docs",
          preview: "Preview https://example.com/preview",
        },
        {
          label: "Install manually",
          description: "Configure it yourself",
          preview: "Manual preview",
        },
      ],
      recommended: 0,
    },
  ],
};

function renderAsk() {
  return renderToStaticMarkup(
    <AskToolCall
      request={request}
      connection="connected"
      onActivity={() => undefined}
      onRespond={async (_response: AskResponse) => undefined}
    />,
  );
}

describe("RichAskToolCall final radio DOM", () => {
  it("keeps visible option copy and link siblings when Base UI resolves Radio.Root", () => {
    const markup = renderAsk();
    const radioButtons = [...markup.matchAll(/<button\b[^>]*role="radio"[^>]*>[\s\S]*?<\/button>/g)].map(
      ([button]) => button,
    );
    const firstOptionRow = markup.match(/<div class="ask-option-row">([\s\S]*?)<\/div>/)?.[1];

    expect(radioButtons).toHaveLength(2);
    expect(radioButtons[0]).toContain('aria-label="Install recommended https://example.com/install"');
    expect(radioButtons[0]).toContain('role="radio"');
    expect(radioButtons[0]).toContain('aria-checked="false"');
    expect(radioButtons[0]).toContain('class="ask-option-copy"');
    expect(radioButtons[0]).toContain("Install recommended ");
    expect(radioButtons[0]).toContain('class="ask-option-description"');
    expect(radioButtons[0]).toContain("Use the docs ");
    expect(radioButtons[0]).toContain('class="ask-option-preview"');
    expect(radioButtons[0]).toContain("Preview ");
    expect(radioButtons[0]).toContain("Recommended");
    expect(radioButtons[0]).not.toContain("<a ");
    expect(radioButtons[1]).toContain('class="ask-option-copy"');
    expect(radioButtons[1]).toContain("Install manually");
    expect(radioButtons[1]).toContain('class="ask-option-description"');
    expect(radioButtons[1]).toContain("Configure it yourself");
    expect(radioButtons[1]).toContain('class="ask-option-preview"');
    expect(radioButtons[1]).toContain("Manual preview");
    expect(radioButtons[1]).not.toContain("<a ");
    expect(markup).toMatch(
      /<input[^>]*type="radio"[^>]*value="Install recommended https:\/\/example.com\/install"/,
    );
    expect(firstOptionRow).toMatch(
      /<button[\s\S]*<\/button>[\s\S]*<span class="ask-option-links">[\s\S]*<a /,
    );
  });
});
