// biome-ignore-all assist/source/organizeImports: The test support must install the React hook mock first.
import {
  BASE_SESSION,
  DASHBOARD_DEFAULTS,
  findElements,
  findHostText,
  renderControlledDashboard,
  textContent,
} from "./dashboard-test-support.js";
import { describe, expect, it, vi } from "vitest";
import { ApplicationErrorViewer } from "../application-error-viewer.js";
describe("dashboard application errors view navigation", () => {
  const sampleErrors = [
    {
      id: "err-1",
      timestamp: "2026-08-17T12:00:00.000Z",
      source: "daemon" as const,
      severity: "error" as const,
      message: "Socket connection lost",
    },
    {
      id: "err-2",
      timestamp: "2026-08-17T13:00:00.000Z",
      source: "browser" as const,
      severity: "fatal" as const,
      message: "Renderer crashed",
    },
  ];

  it("transitions between sessions and application errors view without clearing selection", () => {
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION],
      sessionsReady: true,
      selectedSessionId: "session-1",
      applicationErrors: sampleErrors,
      onSelectedSessionChange: vi.fn(),
    };

    let output = renderControlledDashboard(props);
    expect(findHostText(output, "h1")).toBe("Bootstrap");

    // Find the sidebar Errors button in footer
    const errorsTrigger = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("sidebar-errors-trigger"),
    )[0];
    expect(errorsTrigger).toBeDefined();
    expect(errorsTrigger?.props["aria-label"]).toBe("Application errors, 2 recorded");
    expect(errorsTrigger?.props["aria-current"]).toBeUndefined();

    // Click Errors button to switch view
    (errorsTrigger?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // ApplicationErrorViewer is rendered in the dashboard inset
    const viewerElement = findElements(output, (el) => el.type === ApplicationErrorViewer)[0];
    expect(viewerElement).toBeDefined();
    expect(viewerElement?.props.errors).toEqual(sampleErrors);

    // Active view attribute on trigger is set
    const activeErrorsTrigger = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("sidebar-errors-trigger"),
    )[0];
    expect(activeErrorsTrigger?.props["aria-current"]).toBe("page");

    // Click a session from the list to return to sessions view
    const sessionItem = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("session-item"),
    )[0];
    (sessionItem?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // Sessions view is restored with selected session intact
    expect(findHostText(output, "h1")).toBe("Bootstrap");
    expect(findElements(output, (el) => el.type === ApplicationErrorViewer)).toHaveLength(0);
  });

  it("returns to sessions view when back button in error viewer is clicked", () => {
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION],
      sessionsReady: true,
      selectedSessionId: "session-1",
      applicationErrors: sampleErrors,
      onSelectedSessionChange: vi.fn(),
    };

    let output = renderControlledDashboard(props);
    const errorsTrigger = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("sidebar-errors-trigger"),
    )[0];
    (errorsTrigger?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const viewerElement = findElements(output, (el) => el.type === ApplicationErrorViewer)[0];
    expect(viewerElement).toBeDefined();

    // Trigger onBackToSessions on the viewer
    (viewerElement?.props.onBackToSessions as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(findHostText(output, "h1")).toBe("Bootstrap");
    expect(findElements(output, (el) => el.type === ApplicationErrorViewer)).toHaveLength(0);
  });

  it("retains connection status in sidebar footer when viewing application errors", () => {
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION],
      sessionsReady: true,
      connection: "connected" as const,
      selectedSessionId: "session-1",
      applicationErrors: sampleErrors,
      onSelectedSessionChange: vi.fn(),
    };

    let output = renderControlledDashboard(props);
    const errorsTrigger = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("sidebar-errors-trigger"),
    )[0];
    (errorsTrigger?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const connectionStatus = findElements(
      output,
      (el) => el.props.className === "sidebar-connection-status",
    )[0];
    expect(connectionStatus).toBeDefined();
    expect(textContent(connectionStatus)).toContain("Host connected");
  });
});
