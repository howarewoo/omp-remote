// biome-ignore-all assist/source/organizeImports: The test support must install the React hook mock first.
import {
  findElements,
  getReactHarness,
  textContent,
} from "./dashboard/dashboard-test-support.js";
import type { ActiveSubagent, Session } from "@omp-remote/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatSubagentModelLabel, SubagentSessionViewer } from "./subagent-session-viewer.js";
import { DrawerContent } from "./ui/drawer.js";

const reactHarness = getReactHarness();

const SUBAGENT: ActiveSubagent = {
  id: "subagent-1",
  name: "ResearchAgent",
  lastActivity: "2026-08-17T12:00:00.000Z",
};

const BASE_SUBAGENT_SESSION: Session = {
  id: "subagent-1",
  source: "rpc",
  name: "ResearchAgent",
  cwd: "/work/omp-remote",
  branch: "feature/subagent-metadata",
  status: "running",
  connected: true,
  model: "openai/gpt-5.6",
  effort: "high",
  availableModels: [
    {
      provider: "openai",
      id: "gpt-5.6",
      name: "GPT-5.6 Cyber",
      efforts: ["low", "medium", "high", "xhigh"],
    },
  ],
  contextPercent: 42,
  createdAt: "2026-08-17T11:00:00.000Z",
  lastActivity: "2026-08-17T12:00:00.000Z",
  capabilities: ["prompt", "abort"],
  messages: [],
  sessionPath: "/work/omp-remote/.sessions/subagent-1.jsonl",
  parentSessionId: "root-session",
  costSummary: {
    totalUsd: 0.185,
    partial: false,
    agents: [
      {
        sessionId: "subagent-1",
        name: "ResearchAgent",
        parentSessionId: "root-session",
        totalUsd: 0.185,
        available: true,
      },
    ],
  },
  activeSubagents: [],
  skillCommands: [],
};

describe("formatSubagentModelLabel", () => {
  it("returns Default for undefined or empty session model", () => {
    expect(formatSubagentModelLabel(undefined)).toBe("Default");
    expect(formatSubagentModelLabel(null)).toBe("Default");
    expect(formatSubagentModelLabel({ ...BASE_SUBAGENT_SESSION, model: null })).toBe("Default");
  });

  it("finds matching model name from availableModels by id or provider/id", () => {
    expect(formatSubagentModelLabel(BASE_SUBAGENT_SESSION)).toBe("GPT-5.6 Cyber");
    expect(
      formatSubagentModelLabel({
        ...BASE_SUBAGENT_SESSION,
        model: "gpt-5.6",
      }),
    ).toBe("GPT-5.6 Cyber");
  });

  it("falls back to the last segment of the model identifier if not in availableModels", () => {
    expect(
      formatSubagentModelLabel({
        ...BASE_SUBAGENT_SESSION,
        model: "anthropic/claude-3-7-sonnet",
      }),
    ).toBe("claude-3-7-sonnet");
  });
});

describe("SubagentSessionViewer", () => {
  beforeEach(() => {
    reactHarness.refIndex = 0;
    reactHarness.refValues = [];
    reactHarness.effectIndex = 0;
    reactHarness.effectValues = [];
  });

  it("renders subagent metadata when session is present", () => {
    const output = SubagentSessionViewer({
      open: true,
      mobile: false,
      subagent: SUBAGENT,
      session: BASE_SUBAGENT_SESSION,
      detailsState: "live",
      onRetry: vi.fn(),
      onOpenChange: vi.fn(),
      children: "Transcript content",
    });

    const panel = findElements(output, (el) => el.type === DrawerContent)[0];
    expect(panel?.props.className).toBe("subagent-session-panel");

    const metadata = findElements(output, (el) => el.props.className === "subagent-session-metadata")[0];
    expect(metadata).toBeDefined();

    const text = textContent(metadata);
    expect(text).toContain("Branch");
    expect(text).toContain("feature/subagent-metadata");
    expect(text).toContain("Model · Effort");
    expect(text).toContain("GPT-5.6 Cyber");
    expect(text).toContain("High");
    expect(text).toContain("Context");
    expect(text).toContain("42%");
    expect(text).toContain("Cost");
    expect(text).toContain("$0.19");
  });

  it("renders partial indicator for partial cost summaries", () => {
    const output = SubagentSessionViewer({
      open: true,
      mobile: false,
      subagent: SUBAGENT,
      session: {
        ...BASE_SUBAGENT_SESSION,
        costSummary: {
          totalUsd: 1.25,
          partial: true,
          agents: [
            {
              sessionId: "subagent-1",
              name: "ResearchAgent",
              parentSessionId: "root-session",
              totalUsd: 1.25,
              available: true,
            },
          ],
        },
      },
      detailsState: "live",
      onRetry: vi.fn(),
      onOpenChange: vi.fn(),
      children: "Transcript content",
    });

    const metadata = findElements(output, (el) => el.props.className === "subagent-session-metadata")[0];
    expect(textContent(metadata)).toContain("$1.25 · Partial");
  });

  it("omits branch metadata and formats dashes when optional fields are absent", () => {
    const output = SubagentSessionViewer({
      open: true,
      mobile: false,
      subagent: SUBAGENT,
      session: {
        ...BASE_SUBAGENT_SESSION,
        branch: null,
        contextPercent: null,
        costSummary: undefined,
        effort: null,
        model: null,
      },
      detailsState: "saved",
      onRetry: vi.fn(),
      onOpenChange: vi.fn(),
      children: "Transcript content",
    });

    const metadata = findElements(output, (el) => el.props.className === "subagent-session-metadata")[0];
    const text = textContent(metadata);
    expect(text).not.toContain("Branch");
    expect(text).toContain("Model · Effort");
    expect(text).toContain("Default");
    expect(text).toContain("Default effort");
    expect(text).toContain("Context");
    expect(text).toContain("—");
    expect(text).toContain("Cost");
  });

  it("does not render metadata section when session is null (loading or error state)", () => {
    const loadingOutput = SubagentSessionViewer({
      open: true,
      mobile: false,
      subagent: SUBAGENT,
      session: null,
      detailsState: "loading",
      onRetry: vi.fn(),
      onOpenChange: vi.fn(),
      children: "Loading...",
    });

    expect(
      findElements(loadingOutput, (el) => el.props.className === "subagent-session-metadata"),
    ).toHaveLength(0);
  });
});
