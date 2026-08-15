import { describe, expect, it } from "vitest";
import { SidebarHeader, SidebarTrigger } from "../ui/sidebar.js";
import {
  BASE_SESSION,
  composerDashboardProps,
  findElements,
  getReactHarness,
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

describe("dashboard sidebar header", () => {
  it("omits the sidebar toggle from the sidebar header on desktop", () => {
    const reactHarness = getReactHarness();
    reactHarness.isMobile = false;

    const output = renderControlledDashboard(composerDashboardProps(BASE_SESSION));
    const sidebarHeader = findElements(output, (element) => element.type === SidebarHeader)[0];
    expect(sidebarHeader).toBeDefined();

    const brandLockup = findElements(
      sidebarHeader,
      (element) => element.props.className === "brand-lockup",
    )[0];
    expect(brandLockup).toBeDefined();

    const triggerInSidebar = findElements(sidebarHeader, (element) => element.type === SidebarTrigger);
    expect(triggerInSidebar).toHaveLength(0);
  });

  it("includes the sidebar toggle in the sidebar header on mobile", () => {
    const reactHarness = getReactHarness();
    reactHarness.isMobile = true;

    const output = renderControlledDashboard(composerDashboardProps(BASE_SESSION));
    const sidebarHeader = findElements(output, (element) => element.type === SidebarHeader)[0];
    expect(sidebarHeader).toBeDefined();

    const brandLockup = findElements(
      sidebarHeader,
      (element) => element.props.className === "brand-lockup",
    )[0];
    expect(brandLockup).toBeDefined();

    const triggerInSidebar = findElements(sidebarHeader, (element) => element.type === SidebarTrigger);
    expect(triggerInSidebar).toHaveLength(1);
  });
});
