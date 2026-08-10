import { describe, expect, it } from "vitest";
import {
  BASE_SESSION,
  composerDashboardProps,
  findElements,
  renderControlledDashboard,
  textContent,
} from "./dashboard-test-support.js";

describe("dashboard session header", () => {
  it("shows the working directory tail while retaining the full path", () => {
    const cwd = "/Users/adamwoo/Documents/GitHub/omp-remote";
    const output = renderControlledDashboard(composerDashboardProps({ ...BASE_SESSION, cwd }));
    const root = findElements(output, (element) => element.props.className === "session-root")[0];

    expect(textContent(root)).toBe("…/GitHub/omp-remote");
    expect(root?.props.title).toBe(cwd);
  });
});
