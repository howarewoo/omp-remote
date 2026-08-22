import type { Session } from "@omp-remote/protocol";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupReactHarnessEffects,
  findElements,
  formatToolTextPreview,
  parseTodoResult,
  reactHarness,
  renderToolTranscriptWithHooks,
  renderTranscriptMessageItems,
  renderTranscriptNodes,
  textContent,
  TODO_RESULT_TEXT,
  TodoToolTranscript,
  ToolTranscriptText,
} from "./tool-transcript.test-support.js";
describe("ToolTranscriptText", () => {
  it("does not invent text for an image-only tool disclosure", () => {
    const source = "https://cdn.example/image-only.png";
    const disclosure = ToolTranscriptText({
      entry: {
        id: "tool-image-only",
        role: "tool",
        toolName: "bash",
        text: `![](${source})`,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.filter((node) => node.type === "img").map((node) => node.props?.src)).toEqual([
      source,
      source,
    ]);
    expect(nodes.some((node) => node.className === "transcript-disclosure-text")).toBe(false);
    expect(textContent(disclosure)).not.toContain("No tool output");
    expect(nodes.find((node) => node.className === "disclosure-image-link")?.props?.["aria-label"]).toBe(
      "Open image source",
    );
  });

  it("replaces a failed remote image with an accessible alt fallback", () => {
    const entry = {
      id: "tool-image-failure",
      role: "tool" as const,
      toolName: "bash",
      text: "![Architecture diagram](https://cdn.example/diagram.png)",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text" as const,
    };
    const initialNodes = renderTranscriptNodes(ToolTranscriptText({ entry }));
    const initialImages = initialNodes.filter((node) => node.type === "img");
    expect(initialImages).toHaveLength(2);
    for (const image of initialImages) {
      if (typeof image.props?.onError !== "function") throw new Error("Expected image error handler");
      image.props.onError();
    }

    reactHarness.stateIndex = 0;
    reactHarness.refIndex = 0;
    reactHarness.effectIndex = 0;
    const failedNodes = renderTranscriptNodes(ToolTranscriptText({ entry }));
    const fallbacks = failedNodes.filter((node) => node.className === "disclosure-image-fallback");
    const expandedLink = failedNodes.find((node) => node.className === "disclosure-image-link");

    expect(fallbacks).toHaveLength(2);
    expect(fallbacks.every((fallback) => fallback.text === "Image unavailable: Architecture diagram")).toBe(
      true,
    );
    expect(fallbacks.every((fallback) => fallback.props?.role === "img")).toBe(true);
    expect(
      fallbacks.every(
        (fallback) => fallback.props?.["aria-label"] === "Image unavailable: Architecture diagram",
      ),
    ).toBe(true);
    expect(expandedLink?.props?.href).toBe("https://cdn.example/diagram.png");
    expect(expandedLink?.props?.target).toBe("_blank");
    expect(expandedLink?.props?.rel).toBe("noreferrer");
    expect(expandedLink?.props?.["aria-label"]).toBe("Open image source: Architecture diagram");
  });

  it("marks failed eval disclosures with the error lifecycle", () => {
    const failed = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "eval-error",
          role: "tool",
          toolName: "eval",
          text: "ReferenceError: missingValue is not defined",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
          lifecycle: { state: "error" },
        },
      }),
    );
    const successful = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "eval-success",
          role: "tool",
          toolName: "eval",
          text: "42",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
          lifecycle: { state: "success" },
        },
      }),
    );

    expect(
      failed.find((node) => node.className?.includes("transcript-disclosure-frame"))?.props?.[
        "data-lifecycle"
      ],
    ).toBe("error");
    expect(failed.find((node) => node.className === "transcript-disclosure-status")?.text).toBe("Failed");
    expect(
      successful.find((node) => node.className?.includes("transcript-disclosure-frame"))?.props?.[
        "data-lifecycle"
      ],
    ).toBe("success");
    expect(successful.some((node) => node.className === "transcript-disclosure-status")).toBe(false);
  });

  it("shows the Grep query, result counts, and scope in the disclosure header", () => {
    const title =
      'Grep: type: "toolCall"|toolCallId|arguments: \\{ path|name: "bash"|name: "edit" 24 matches · 3 files · in apps, packages';
    const disclosure = ToolTranscriptText({
      entry: {
        id: "grep-1",
        role: "tool",
        toolName: "grep",
        toolTitle: title,
        text: "matches",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });

    expect(
      textContent(
        renderTranscriptNodes(disclosure).find(
          (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
        )?.props?.children as ReactNode,
      ),
    ).toContain(title);
  });

  it("keeps the answered Ask question in the disclosure header", () => {
    const title = "Ask: Which deployment target? +1 more";
    const disclosure = ToolTranscriptText({
      entry: {
        id: "ask-1",
        role: "tool",
        toolName: "ask",
        toolTitle: title,
        text: "Preview, iad1",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });

    expect(
      textContent(
        renderTranscriptNodes(disclosure).find(
          (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
        )?.props?.children as ReactNode,
      ),
    ).toContain(title);
  });

  it("shows a canonical Read filename with its icon without rendering the result", () => {
    const text = [
      "[packages/features/sessions/src/components/dashboard.tsx#ABCD]",
      "1090:export function ToolTranscriptText() {",
      "1091:  return <details />;",
      "1092:}",
    ].join("\n");
    const disclosure = ToolTranscriptText({
      entry: {
        id: "read-1",
        role: "tool",
        toolName: "read",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(
      textContent(
        nodes.find(
          (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
        )?.props?.children as ReactNode,
      ),
    ).toContain("Read: dashboard.tsx");
    expect(
      nodes.find((node) => node.className === "transcript-disclosure-icon")?.props?.["data-category"],
    ).toBe("read");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
    expect(nodes.some((node) => node.className === "tool-message-preview")).toBe(false);
    expect(nodes.some((node) => node.className === "tool-output-divider")).toBe(false);
    expect(nodes.some((node) => node.text.includes("1091:  return <details />;"))).toBe(false);
  });

  it("renders a short untargeted Read error without disclosure controls", () => {
    const text = "Error: file not found";
    const disclosure = ToolTranscriptText({
      entry: {
        id: "read-error",
        role: "tool",
        toolName: "read",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);
    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));

    expect(nodes[0]).toEqual(
      expect.objectContaining({
        type: "div",
        className: expect.stringContaining("read-result-disclosure"),
      }),
    );
    expect(frame?.props?.["data-state"]).toBe("static");
    expect(
      nodes.find(
        (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
      )?.text,
    ).toContain("Read");
    expect(nodes.find((node) => node.className === "read-result-preview")?.text).toBe(text);
    expect(nodes.filter((node) => node.className === "transcript-disclosure-text")).toHaveLength(1);
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
  });

  it("shows metadata-backed Read filenames without rendering the result", () => {
    const disclosure = ToolTranscriptText({
      entry: {
        id: "read-metadata",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/src/index.ts:1-180",
        text: "canonical read result",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(disclosure.props.category).toBe("read");
    expect(
      textContent(
        nodes.find(
          (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
        )?.props?.children as ReactNode,
      ),
    ).toContain("Read: index.ts");
    expect(
      nodes.find((node) => node.className === "transcript-disclosure-icon")?.props?.["data-category"],
    ).toBe("read");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
    expect(nodes.some((node) => node.text.includes("canonical read result"))).toBe(false);
  });

  it.each([
    "skill://using-woostack/references/session-learning.md",
    "pr://howarewoo/omp-remote/42",
    "issue://OMP-123",
    "agent://reviewer-1/output",
    "artifact://dashboard-result",
    "history://session-1",
    "memory://notes/current",
    "mcp://linear/issues",
    "local://implementation-plan.md",
    "rule://typescript",
    "vault://team/secret",
    "conflict://packages/features/sessions/src/components/dashboard.tsx",
    "https://example.com/docs/read?mode=raw#result",
  ])("renders a short URI-like Read target without disclosure controls: %s", (readTarget) => {
    const text = "# Heading\n**bold** and [docs](https://example.com)\n- literal";
    const disclosure = ToolTranscriptText({
      entry: {
        id: `uri-read-${readTarget}`,
        role: "tool",
        toolName: "read",
        readTarget,
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);
    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    const rawTextNodes = nodes.filter((node) => node.className === "transcript-disclosure-text");

    expect(nodes[0]).toEqual(
      expect.objectContaining({
        type: "div",
        className: expect.stringContaining("read-result-disclosure"),
      }),
    );
    expect(frame?.props?.["data-state"]).toBe("static");
    expect(
      nodes.find(
        (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
      )?.text,
    ).toContain(`Read ${readTarget}`);
    expect(rawTextNodes.map((node) => node.text)).toEqual([text]);
    expect(nodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      "https://example.com",
    ]);
    expect(nodes.filter((node) => node.type === "a").some((node) => node.props?.href === readTarget)).toBe(
      false,
    );
    expect(
      nodes.some((node) => typeof node.type === "string" && ["strong", "code"].includes(node.type)),
    ).toBe(false);
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
  });

  it("infers a URI-like Read target from the snapshot header", () => {
    const readTarget = "pr://howarewoo/omp-remote/42";
    const text = `[${readTarget}#ABCD]\nPull request result`;
    const nodes = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "header-uri-read",
          role: "tool",
          toolName: "read",
          text,
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );

    expect(nodes[0]?.className).toContain("read-result-disclosure");
    expect(
      nodes.find(
        (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
      )?.text,
    ).toContain(`Read ${readTarget}`);
    expect(
      nodes.filter((node) => node.className === "transcript-disclosure-text").map((node) => node.text),
    ).toEqual([text]);
  });

  it("shows resolved-path metadata for an inspectable Read result", () => {
    const readResolvedPath = "/Users/example/.agents/skills/using-woostack/references/session-learning.md";
    const disclosure = ToolTranscriptText({
      entry: {
        id: "resolved-uri-read",
        role: "tool",
        toolName: "read",
        readTarget: "skill://using-woostack/references/session-learning.md",
        readResolvedPath,
        text: "literal result",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.find((node) => node.className === "read-result-resolved-path")?.text).toContain(
      `Resolved path: ${readResolvedPath}`,
    );
  });

  it("keeps local Read image paths out of image disclosure content", () => {
    const readTarget = "/Users/example/work/private/diagram.png";
    const readResolvedPath = "/private/var/tmp/omp/blobs/diagram.png";
    const nodes = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "local-read-image",
          role: "tool",
          toolName: "read",
          readTarget,
          readResolvedPath,
          text: "",
          images: [{ status: "unavailable", reason: "missing" }],
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );

    expect(
      nodes.find(
        (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
      )?.text,
    ).toContain("Read diagram.png");
    expect(nodes.find((node) => node.className === "disclosure-image-fallback")?.text).toBe(
      "Image unavailable: diagram.png",
    );
    expect(nodes.some((node) => node.text.includes(readTarget) || node.text.includes(readResolvedPath))).toBe(
      false,
    );
  });
});
