import { describe, expect, it, vi } from "vitest";
import { findElements, textContent } from "./dashboard-test-support.js";
import { LaunchSessionDialog } from "./launch-session-dialog.js";

describe("LaunchSessionDialog", () => {
  it("renders saved working directory buttons with left-aligned select class and handles selection", () => {
    const onCwdChange = vi.fn();
    const onRemoveWorkingDirectory = vi.fn();
    const output = LaunchSessionDialog({
      open: true,
      cwd: "",
      savedWorkingDirectories: ["/work/repo-a", "/work/repo-b"],
      savedDirectoryPending: null,
      savedDirectoryError: null,
      launchError: null,
      sending: false,
      onOpenChange: vi.fn(),
      onCwdChange,
      onSaveWorkingDirectory: vi.fn(),
      onRemoveWorkingDirectory,
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    });

    const savedButtons = findElements(
      output,
      (element) =>
        typeof element.props.className === "string" &&
        element.props.className.includes("saved-directory-select"),
    );
    expect(savedButtons).toHaveLength(2);
    expect(textContent(savedButtons[0])).toBe("/work/repo-a");
    expect(textContent(savedButtons[1])).toBe("/work/repo-b");

    (savedButtons[0]?.props.onClick as (() => void) | undefined)?.();
    expect(onCwdChange).toHaveBeenCalledWith("/work/repo-a");
  });
});
