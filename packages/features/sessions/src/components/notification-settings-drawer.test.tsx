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

function renderSettings(state: "enabled" | "blocked" = "enabled", mobile = false) {
  return NotificationSettingsDrawer({
    open: true,
    mobile,
    state,
    preferences: { inputRequired: true, sessionIdle: false },
    error: null,
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
    expect(text.join(" ")).toContain("including rich or legacy Ask requests");
    expect(text.join(" ")).toContain("Session idle");
    expect(labels).toEqual([
      "Close notification settings",
      "Session notification events",
      "Input required notifications",
      "Session idle notifications",
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
    expect(description).toContain("browser settings");
  });

  it("uses the responsive drawer contract on narrow screens", () => {
    const drawer = renderSettings("enabled", true) as NodeLike;
    expect(drawer.props?.showSwipeHandle).toBe(true);
    expect(drawer.props?.swipeDirection).toBe("down");
  });
});
