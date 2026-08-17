import { describe, expect, it } from "vitest";
import { isSidebarCloseSwipe, isSidebarOpenSwipe } from "./sidebar-swipe.js";

describe("isSidebarOpenSwipe", () => {
  it("accepts a deliberate rightward swipe from the viewport edge", () => {
    expect(isSidebarOpenSwipe({ startX: 12, startY: 240, endX: 100, endY: 250 })).toBe(true);
  });

  it.each([
    {
      name: "starts away from the edge",
      swipe: { startX: 25, startY: 240, endX: 120, endY: 240 },
    },
    {
      name: "does not travel far enough",
      swipe: { startX: 12, startY: 240, endX: 75, endY: 240 },
    },
    {
      name: "moves left",
      swipe: { startX: 12, startY: 240, endX: 0, endY: 240 },
    },
    {
      name: "is primarily vertical",
      swipe: { startX: 12, startY: 240, endX: 100, endY: 320 },
    },
  ])("rejects a swipe that $name", ({ swipe }) => {
    expect(isSidebarOpenSwipe(swipe)).toBe(false);
  });
});

describe("isSidebarCloseSwipe", () => {
  it.each([
    {
      side: "left" as const,
      swipe: { startX: 280, startY: 240, endX: 192, endY: 250 },
    },
    {
      side: "right" as const,
      swipe: { startX: 92, startY: 240, endX: 180, endY: 250 },
    },
  ])("accepts a deliberate swipe toward the $side edge", ({ side, swipe }) => {
    expect(isSidebarCloseSwipe(swipe, side)).toBe(true);
  });

  it.each([
    {
      name: "does not travel far enough",
      swipe: { startX: 280, startY: 240, endX: 217, endY: 240 },
    },
    {
      name: "moves away from the sidebar edge",
      swipe: { startX: 280, startY: 240, endX: 360, endY: 240 },
    },
    {
      name: "is primarily vertical",
      swipe: { startX: 280, startY: 240, endX: 192, endY: 320 },
    },
  ])("rejects a swipe that $name", ({ swipe }) => {
    expect(isSidebarCloseSwipe(swipe, "left")).toBe(false);
  });
});
