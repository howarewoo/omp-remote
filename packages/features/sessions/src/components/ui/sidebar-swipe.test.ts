import { describe, expect, it } from "vitest";
import { isSidebarOpenSwipe } from "./sidebar-swipe.js";

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
