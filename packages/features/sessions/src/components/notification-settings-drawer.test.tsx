import { describe, expect, it, vi } from "vitest";
import { NotificationSettingsDrawer } from "./notification-settings-drawer.js";

type NodeLike = { props?: { children?: unknown; [key: string]: unknown } };

function walk(node: unknown, visit: (element: NodeLike) => void): void {
  if (!node || typeof node !== "object") return;
  const element = node as NodeLike;
  if (!element.props) return;
  visit(element);
  const children = element.props.children;
  if (Array.isArray(children)) {
    for (const child of children) walk(child, visit);
  } else {
    walk(children, visit);
  }
  walk(element.props.render, visit);
}

function renderSettings(
  state: "enabled" | "blocked" | "error" | "prompt" | "unsupported" = "enabled",
  mobile = false,
  error: string | null = null,
) {
  return NotificationSettingsDrawer({
    open: true,
    mobile,
    state,
    preferences: { inputRequired: true, sessionIdle: false },
    error,
    onOpenChange: vi.fn(),
    onToggleEvent: vi.fn().mockResolvedValue(undefined),
  });
}

describe("NotificationSettingsDrawer", () => {
  it("keeps both event rows and causal copy visible", () => {
    const drawer = renderSettings();
    const text: string[] = [];
    const labels: string[] = [];
    walk(drawer, (element) => {
      if (typeof element.props?.children === "string") text.push(element.props.children);
      if (typeof element.props?.["aria-label"] === "string")
        labels.push(element.props["aria-label"] as string);
    });

    expect(text.join(" ")).toContain("Input required");
    expect(text.join(" ")).toContain("host reports");
    expect(text.join(" ")).toContain("Ask request");
    expect(labels).toEqual([
      "Close notification settings",
      "Session notification events",
      "Input required notifications",
      "Session idle notifications",
    ]);
    const describedBy: string[] = [];
    walk(drawer, (element) => {
      if (typeof element.props?.["aria-describedby"] === "string") {
        describedBy.push(element.props["aria-describedby"] as string);
      }
    });
    expect(describedBy).toEqual([
      "notification-event-inputRequired-description",
      "notification-event-sessionIdle-description",
    ]);
  });

  it("disables both switches with browser-settings guidance when blocked", () => {
    const drawer = renderSettings("blocked");
    const switches: unknown[] = [];
    let description = "";
    walk(drawer, (element) => {
      if (
        typeof element.props?.["aria-label"] === "string" &&
        String(element.props["aria-label"]).endsWith("notifications")
      ) {
        switches.push(element.props.disabled);
      }
      if (typeof element.props?.children === "string") description += ` ${element.props.children}`;
    });

    expect(switches).toEqual([true, true]);
    expect(description).toContain("browser or device settings");
  });

  it("explains installation, explicit permission, independent preferences, and sync failures", () => {
    const cases = [
      ["unsupported", "HTTPS", "iPhone or iPad"],
      ["prompt", "only after you choose", "enable Web Push"],
      ["enabled", "host-reported events", "stay independent"],
      ["error", "Host registration failed", "Host registration failed"],
    ] as const;

    for (const [state, first, second] of cases) {
      const drawer = renderSettings(state, false, state === "error" ? "Host registration failed" : null);
      let text = "";
      let alertRole: unknown;
      walk(drawer, (element) => {
        if (typeof element.props?.children === "string") text += ` ${element.props.children}`;
        if (element.props?.role === "alert") alertRole = element.props.role;
      });
      expect(text).toContain(first);
      expect(text).toContain(second);
      expect(alertRole).toBe(state === "error" ? "alert" : undefined);
    }
  });

  it("uses the responsive drawer contract on narrow screens", () => {
    const drawer = renderSettings("enabled", true) as NodeLike;
    expect(drawer.props?.showSwipeHandle).toBe(true);
    expect(drawer.props?.swipeDirection).toBe("down");
  });
});
