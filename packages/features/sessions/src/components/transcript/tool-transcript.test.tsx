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

  it("renders every Read payload state without sourcing or exposing its resolved local path", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:read-image");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    reactHarness.lifecycleEffects = true;
    const readTarget = "skill://using-woostack/assets/diagram.png";
    const readResolvedPath = "/Users/example/.agents/skills/using-woostack/assets/diagram.png";
    const entry: Session["messages"][number] = {
      id: "read-image-payloads",
      role: "tool",
      toolName: "read",
      readTarget,
      readResolvedPath,
      text: "",
      images: [
        { status: "available", mimeType: "image/png", data: "AQIDBA==" },
        { status: "unavailable", reason: "missing" },
        { status: "available", mimeType: "image/webp", data: "%%%=" },
      ],
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text",
    };

    try {
      const pendingNodes = renderToolTranscriptWithHooks(entry);
      expect(
        pendingNodes
          .filter((node) => node.className === "disclosure-image-fallback")
          .map((node) => node.text),
      ).toEqual([
        `Loading image: ${readTarget}`,
        `Image unavailable: ${readTarget}`,
        `Loading image: ${readTarget}`,
        `Loading image: ${readTarget}`,
        `Image unavailable: ${readTarget}`,
        `Loading image: ${readTarget}`,
      ]);
      const nodes = renderToolTranscriptWithHooks(entry, true);
      const images = nodes.filter((node) => node.type === "img");
      const links = nodes.filter((node) => node.className === "disclosure-image-link");
      const fallbacks = nodes.filter((node) => node.className === "disclosure-image-fallback");
      const blob = createObjectURL.mock.calls[0]?.[0];
      expect(blob).toBeInstanceOf(Blob);
      if (!(blob instanceof Blob)) throw new Error("Expected createObjectURL to receive a Blob");

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(blob.type).toBe("image/png");
      expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3, 4]);
      expect(nodes.filter((node) => node.className === "disclosure-image")).toHaveLength(6);
      expect(images.map((node) => node.props?.src)).toEqual(["blob:read-image", "blob:read-image"]);
      expect(
        links.map((node) => ({
          href: node.props?.href,
          rel: node.props?.rel,
          target: node.props?.target,
        })),
      ).toEqual([{ href: "blob:read-image", rel: "noreferrer", target: "_blank" }]);
      expect(fallbacks).toHaveLength(4);
      expect(fallbacks.every((node) => node.text === `Image unavailable: ${readTarget}`)).toBe(true);
      expect(nodes.some((node) => node.text.includes(readResolvedPath))).toBe(false);
      expect(
        nodes.some((node) => node.props?.src === readResolvedPath || node.props?.href === readResolvedPath),
      ).toBe(false);

      const thumbnailImage = images[0];
      if (typeof thumbnailImage?.props?.onError !== "function")
        throw new Error("Expected Read image error handler");
      thumbnailImage.props.onError();
      const failedNodes = renderToolTranscriptWithHooks(entry, true);
      expect(
        failedNodes.filter((node) => node.className === "disclosure-image-fallback").map((node) => node.text),
      ).toContain(`Image unavailable: ${readTarget}`);
      expect(failedNodes.filter((node) => node.type === "img")).toHaveLength(1);
    } finally {
      cleanupReactHarnessEffects();
      reactHarness.lifecycleEffects = false;
      vi.unstubAllGlobals();
    }
  });

  it("revokes Read payload object URLs exactly on replacement and unmount", () => {
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce("blob:first-read-image")
      .mockReturnValueOnce("blob:replacement-read-image");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    reactHarness.lifecycleEffects = true;
    const firstImages: NonNullable<Session["messages"][number]["images"]> = [
      { status: "available", mimeType: "image/png", data: "AQIDBA==" },
    ];
    const replacementImages: NonNullable<Session["messages"][number]["images"]> = [
      { status: "available", mimeType: "image/jpeg", data: "BQYHCA==" },
    ];
    const baseEntry: Session["messages"][number] = {
      id: "read-image-lifecycle",
      role: "tool",
      toolName: "read",
      readTarget: "artifact://image-result",
      text: "",
      images: firstImages,
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text",
    };

    try {
      renderToolTranscriptWithHooks(baseEntry);
      const initialNodes = renderToolTranscriptWithHooks(baseEntry, true);
      expect(initialNodes.filter((node) => node.type === "img").map((node) => node.props?.src)).toEqual([
        "blob:first-read-image",
        "blob:first-read-image",
      ]);
      expect(revokeObjectURL).not.toHaveBeenCalled();

      const replacementEntry = { ...baseEntry, images: replacementImages };
      renderToolTranscriptWithHooks(replacementEntry, true);
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenLastCalledWith("blob:first-read-image");
      const replacementNodes = renderToolTranscriptWithHooks(replacementEntry, true);
      expect(replacementNodes.filter((node) => node.type === "img").map((node) => node.props?.src)).toEqual([
        "blob:replacement-read-image",
        "blob:replacement-read-image",
      ]);

      const emptyEntry = { ...baseEntry, images: [] };
      renderToolTranscriptWithHooks(emptyEntry, true);
      expect(revokeObjectURL).toHaveBeenCalledTimes(2);
      expect(revokeObjectURL).toHaveBeenLastCalledWith("blob:replacement-read-image");
      const emptyNodes = renderToolTranscriptWithHooks(emptyEntry, true);
      expect(emptyNodes.some((node) => node.type === "img")).toBe(false);

      cleanupReactHarnessEffects();
      expect(revokeObjectURL).toHaveBeenCalledTimes(2);
      expect(createObjectURL).toHaveBeenCalledTimes(2);
    } finally {
      cleanupReactHarnessEffects();
      reactHarness.lifecycleEffects = false;
      vi.unstubAllGlobals();
    }
  });

  it("truncates an inspectable Read preview without truncating its expandable raw result", () => {
    const text = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n");
    const disclosure = ToolTranscriptText({
      entry: {
        id: "truncated-uri-read",
        role: "tool",
        toolName: "read",
        readTarget: "ssh://example.com/var/log/omp.log",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.find((node) => node.className === "read-result-preview")?.text).toContain(
      "line 12… 2 more lines",
    );
    expect(nodes.filter((node) => node.className === "transcript-disclosure-text").at(-1)?.text).toBe(text);
  });

  it("renders adjacent Reads as separate sequential scroller items", () => {
    const messages: Session["messages"] = [
      {
        id: "read-first",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/a.ts",
        text: "alpha",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "read-second",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/b.ts",
        text: "beta",
        timestamp: "2026-07-29T12:00:01.000Z",
        streaming: false,
        presentation: "text",
      },
    ];
    const rows = renderTranscriptMessageItems({ messages });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row?.key)).toEqual(["read-first", "read-second"]);
  });

  it("renders short edit output without disclosure controls", () => {
    const block = ToolTranscriptText({
      entry: {
        id: "edit-1",
        role: "tool",
        toolName: "edit",
        toolTitle: "Edit: 🟦 src/dashboard.tsx ⟦+1⟧ ⟦−1⟧",
        text: "-1|before\n+1|after",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "diff",
      },
    });
    const nodes = renderTranscriptNodes(block);

    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    expect(frame?.props?.["data-state"]).toBe("static");
    expect(frame?.className).toContain("tool-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(frame?.className).toContain("tool-output-disclosure");
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
    expect(nodes.some((node) => node.className === "transcript-disclosure-panel")).toBe(false);
    expect(
      textContent(
        nodes.find(
          (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
        )?.props?.children as ReactNode,
      ),
    ).toContain("Edit: 🟦 src/dashboard.tsx ⟦+1⟧ ⟦−1⟧");
  });

  it("renders short write output directly in the shared static frame", () => {
    const text = ["Wrote 42 bytes to", "packages/features/sessions/src/components/dashboard.tsx"].join("\n");
    const disclosure = ToolTranscriptText({
      entry: {
        id: "write-1",
        role: "tool",
        toolName: "write",
        toolTitle: "Write: packages/features/sessions/src/components/dashboard.tsx",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    expect(frame?.props?.["data-state"]).toBe("static");
    expect(frame?.className).toContain("tool-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(frame?.className).toContain("tool-output-disclosure");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
    expect(
      textContent(
        nodes.find(
          (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
        )?.props?.children as ReactNode,
      ),
    ).toContain("Write: packages/features/sessions/src/components/dashboard.tsx");
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.find((node) => node.className === "transcript-disclosure-text")?.text).toBe(text);
    expect(nodes.some((node) => node.className === "transcript-disclosure-panel")).toBe(false);
  });

  it("collapses completed long Write output with a populated preview", () => {
    const text = Array.from({ length: 14 }, (_, index) => `write line ${index + 1}`).join("\n");
    const disclosure = ToolTranscriptText({
      entry: {
        id: "write-long",
        role: "tool",
        toolName: "write",
        toolTitle: "Write: packages/features/sessions/src/components/dashboard.tsx",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);
    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    const output = nodes.find((node) => node.className === "tool-output-divider");
    const preview = nodes.find((node) => node.className === "transcript-disclosure-text");

    expect(frame?.props?.["data-state"]).toBe("closed");
    expect(output?.text).toBe("Output");
    expect(preview?.text).toContain("write line 5");
    expect(preview?.text).toContain("write line 14");
    expect(preview?.text).not.toContain("write line 4");
  });

  it.each(["", " \n\t "])("labels empty write output without disclosure controls: %j", (text) => {
    const disclosure = ToolTranscriptText({
      entry: {
        id: "empty-write",
        role: "tool",
        toolName: "write",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);
    expect(nodes.find((node) => node.className === "transcript-disclosure-text")?.text).toBe(
      "No tool output",
    );
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
  });

  it("routes canonical todo output to a closed progress summary and state list", () => {
    const entry = {
      id: "todo-1",
      role: "tool" as const,
      toolName: "todo",
      text: TODO_RESULT_TEXT,
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text" as const,
    };
    const nodes = renderTranscriptNodes(ToolTranscriptText({ entry }));

    expect(nodes.find((node) => node.className === "todo-tool-summary")?.text).toContain("2/4 complete");
    expect(nodes.find((node) => node.className === "todo-blocked-count")?.text).toBe("1 blocked");
    expect(nodes.find((node) => node.className === "todo-active-task")?.text).toContain(
      "In progress: Build custom todo tool interface",
    );
    expect(nodes.find((node) => node.className === "todo-task-reason")?.text).toBe(
      "Blocked reason: format probe",
    );

    const parsed = parseTodoResult(TODO_RESULT_TEXT);
    if (!parsed) throw new Error("Expected canonical todo output to parse");
    const disclosure = TodoToolTranscript({ entry, todo: parsed });
    const disclosureNodes = renderTranscriptNodes(disclosure);
    const frame = disclosureNodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    expect(frame?.props?.["data-state"]).toBe("closed");
    expect(frame?.className).toContain("tool-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(frame?.className).toContain("todo-tool-disclosure");
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.findIndex((node) => node.className === "tool-output-divider")).toBeLessThan(
      nodes.findIndex((node) => node.className === "todo-tool-summary"),
    );
    expect(nodes.filter((node) => node.type === "ul")).toHaveLength(3);
    const progress = findElements(disclosure, (element) => element.type === "progress")[0];
    if (!progress) throw new Error("Expected Todo progress element");
    expect({
      type: progress.type,
      value: progress.props.value,
      max: progress.props.max,
      label: progress.props["aria-label"],
    }).toEqual({
      type: "progress",
      value: 2,
      max: 4,
      label: "Overall todo progress: 2 of 4 tasks complete",
    });
    expect(
      nodes.filter((node) => node.className?.includes("todo-state-badge")).map((node) => node.text),
    ).toEqual(["Completed", "Completed", "Completed", "In progress", "In progress", "Blocked", "Blocked"]);
  });

  it("uses resolved semantics when dropped tasks contribute to done progress", () => {
    const mixedText = [
      "Overall: 1/2 done, 1 open.",
      'Active phase 1/1 "Work" (1/2).',
      "  Work:",
      "    - [ ] Retire legacy path (dropped)",
      "    - [ ] Build replacement (in progress)",
    ].join("\n");
    const mixedTodo = parseTodoResult(mixedText);
    if (!mixedTodo) throw new Error("Expected mixed dropped todo output to parse");
    const mixedNodes = renderTranscriptNodes(
      TodoToolTranscript({
        entry: {
          id: "todo-mixed-dropped",
          role: "tool",
          toolName: "todo",
          text: mixedText,
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
        todo: mixedTodo,
      }),
    );
    expect(mixedNodes.find((node) => node.className === "todo-tool-summary")?.text).toContain("1/2 resolved");

    const droppedText = ["Overall: 1/1 done.", "  Finish:", "    - [ ] Retire task (dropped)"].join("\n");
    const droppedTodo = parseTodoResult(droppedText);
    if (!droppedTodo) throw new Error("Expected all-dropped todo output to parse");
    const droppedDisclosure = TodoToolTranscript({
      entry: {
        id: "todo-all-dropped",
        role: "tool",
        toolName: "todo",
        text: droppedText,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      todo: droppedTodo,
    });
    const droppedNodes = renderTranscriptNodes(droppedDisclosure);
    expect(droppedNodes.find((node) => node.className === "todo-active-task")?.text).toBe("No tasks remain");
    expect(droppedNodes.find((node) => node.className === "todo-state-marker")?.props?.["data-state"]).toBe(
      "dropped",
    );

    const completedText = ["Overall: 1/1 done.", "  Finish:", "    - [x] Ship task"].join("\n");
    const completedTodo = parseTodoResult(completedText);
    if (!completedTodo) throw new Error("Expected completed todo output to parse");
    const completedDisclosure = TodoToolTranscript({
      entry: {
        id: "todo-completed",
        role: "tool",
        toolName: "todo",
        text: completedText,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      todo: completedTodo,
    });
    const completedNodes = renderTranscriptNodes(completedDisclosure);
    expect(completedNodes.find((node) => node.className === "todo-active-task")?.text).toBe(
      "All tasks complete",
    );
    expect(completedNodes.find((node) => node.className === "todo-state-marker")?.props?.["data-state"]).toBe(
      "completed",
    );
  });

  it("falls back to generic output when a todo result includes errors", () => {
    const text = [
      "Errors: failed to update todo state",
      "Overall: 1/1 done.",
      "  Finish:",
      "    - [x] Hand off",
    ].join("\n");
    const block = ToolTranscriptText({
      entry: {
        id: "todo-error",
        role: "tool",
        toolName: "todo",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });

    expect(parseTodoResult(text)).toBeNull();
    const frame = renderTranscriptNodes(block).find((node) =>
      node.className?.includes("transcript-disclosure-frame"),
    );
    expect(frame?.className).toContain("tool-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(frame?.className).toContain("tool-output-disclosure");
    expect(
      renderTranscriptNodes(block).find((node) => node.className === "transcript-disclosure-text")?.text,
    ).toContain("Errors:");
    expect(renderTranscriptNodes(block).some((node) => node.className === "tool-output-divider")).toBe(true);
  });

  it("falls back to the generic todo disclosure for malformed output", () => {
    const text = "Overall: almost done.\nArbitrary output";
    const block = ToolTranscriptText({
      entry: {
        id: "todo-invalid",
        role: "tool",
        toolName: "todo",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });

    const frame = renderTranscriptNodes(block).find((node) =>
      node.className?.includes("transcript-disclosure-frame"),
    );
    expect(frame?.className).toContain("tool-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(frame?.className).toContain("tool-output-disclosure");
    expect(
      renderTranscriptNodes(block).find((node) => node.className === "transcript-disclosure-text")?.text,
    ).toBe(formatToolTextPreview(text));
    expect(renderTranscriptNodes(block).some((node) => node.className === "tool-output-divider")).toBe(true);
  });

  it("bounds a long single-line preview without leaving it empty", () => {
    const preview = formatToolTextPreview(`${"x".repeat(1_400)}tail`);

    expect(preview).toHaveLength(1_200);
    expect(preview.startsWith("…")).toBe(true);
    expect(preview.endsWith("tail")).toBe(true);
  });

  it("labels an empty tool result", () => {
    expect(formatToolTextPreview("")).toBe("No tool output");
  });
});
