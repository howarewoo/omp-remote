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

describe("RichAskToolCall final Questionnaire DOM", () => {
  it("keeps visible option copy and link siblings outside Questionnaire choices", () => {
    const markup = renderAsk();
    const choices = [
      ...markup.matchAll(/<label\b[^>]*data-slot="questionnaire-choice"[^>]*>[\s\S]*?<\/label>/g),
    ].map(([choice]) => choice);
    const firstOptionRow = markup.match(/<div class="ask-option-row">([\s\S]*?)<\/div>/)?.[1];

    expect(choices).toHaveLength(3);
    expect(choices[0]).toContain('data-slot="questionnaire-choice"');
    expect(choices[0]).toContain('class="ask-option ask-rich-option"');
    expect(choices[0]).toContain('type="radio"');
    expect(choices[0]).toContain('value="ask-option-0-0"');
    expect(choices[0]).toContain('class="ask-option-copy"');
    expect(choices[0]).toContain("Install recommended ");
    expect(choices[0]).toContain('class="ask-option-description"');
    expect(choices[0]).toContain("Use the docs ");
    expect(choices[0]).toContain('class="ask-option-preview"');
    expect(choices[0]).toContain("Preview ");
    expect(choices[0]).toContain("Recommended");
    expect(choices[0]).not.toContain("<a ");
    expect(choices[1]).toContain('class="ask-option-copy"');
    expect(choices[1]).toContain("Install manually");
    expect(choices[1]).not.toContain("<a ");
    expect(firstOptionRow).toMatch(
      /<label[\s\S]*data-slot="questionnaire-choice"[\s\S]*<\/label>[\s\S]*<span class="ask-option-links">[\s\S]*<a /,
    );
  });
});
