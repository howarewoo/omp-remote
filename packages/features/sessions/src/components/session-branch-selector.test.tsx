import type { SessionBranchTopology } from "@omp-remote/protocol";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  filterSessionBranchTopologyRows,
  getSessionBranchTopologyRows,
  SessionBranchSelector,
  type SessionBranchSelectorProps,
} from "./session-branch-selector.js";
import { Drawer } from "./ui/drawer.js";
import { Input } from "./ui/input.js";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group.js";

const LONG_BRANCH = `feature/${"nested-branch-segment-".repeat(10)}`.slice(0, 255);
const TOPOLOGY: SessionBranchTopology = {
  sessionId: "session-1",
  currentBranch: "feature/child",
  branches: [
    { name: "feature/child", parent: "feature/parent" },
    { name: "feature/parent", parent: "main" },
    { name: "feature/sibling", parent: "main" },
    { name: LONG_BRANCH, parent: "feature/parent" },
    { name: "main" },
  ],
};

type TestProps = Record<string, unknown> & { children?: ReactNode; className?: string };

function findElements(
  node: ReactNode,
  predicate: (element: ReactElement<TestProps>) => boolean,
): ReactElement<TestProps>[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, predicate));
  if (!isValidElement<TestProps>(node)) return [];
  return [...(predicate(node) ? [node] : []), ...findElements(node.props.children, predicate)];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement<TestProps>(node)) return "";
  return textContent(node.props.children);
}

function selectorProps(overrides: Partial<SessionBranchSelectorProps> = {}): SessionBranchSelectorProps {
  return {
    open: true,
    mobile: false,
    currentBranch: TOPOLOGY.currentBranch,
    topology: TOPOLOGY,
    query: "",
    loading: false,
    loadError: null,
    checkoutPending: null,
    checkoutError: null,
    running: false,
    onQueryChange: vi.fn(),
    onSelectBranch: vi.fn(),
    onOpenChange: vi.fn(),
    ...overrides,
  };
}

function renderSelector(overrides: Partial<SessionBranchSelectorProps> = {}): ReactNode {
  return SessionBranchSelector(selectorProps(overrides));
}

function branchOptions(node: ReactNode): ReactElement<TestProps>[] {
  return findElements(
    node,
    (element) =>
      element.type === RadioGroupItem &&
      typeof element.props.className === "string" &&
      element.props.className.includes("session-branch-option"),
  );
}

describe("session branch topology presentation", () => {
  it("keeps daemon topology order while filtering names case-insensitively", () => {
    expect(getSessionBranchTopologyRows(TOPOLOGY)).toMatchObject([
      { branch: { name: "feature/child" }, depth: 2, index: 0, parentIndex: 1 },
      { branch: { name: "feature/parent" }, depth: 1, index: 1, parentIndex: 4 },
      { branch: { name: "feature/sibling" }, depth: 1, index: 2, parentIndex: 4 },
      { branch: { name: LONG_BRANCH }, depth: 2, index: 3, parentIndex: 1 },
      { branch: { name: "main" }, depth: 0, index: 4, parentIndex: null },
    ]);
    expect(filterSessionBranchTopologyRows(TOPOLOGY, "FEATURE/").map(({ branch }) => branch.name)).toEqual([
      "feature/child",
      "feature/parent",
      "feature/sibling",
      LONG_BRANCH,
    ]);
    expect(filterSessionBranchTopologyRows(TOPOLOGY, "sibling").map(({ branch }) => branch.name)).toEqual([
      "feature/sibling",
    ]);
  });

  it("terminates cyclic parents and caps deep topology rails", () => {
    const cycle: SessionBranchTopology = {
      sessionId: "cycle",
      currentBranch: "feature/a",
      branches: [
        { name: "feature/a", parent: "feature/b" },
        { name: "feature/b", parent: "feature/a" },
      ],
    };
    const deep: SessionBranchTopology = {
      sessionId: "deep",
      currentBranch: "feature/leaf",
      branches: [
        { name: "feature/leaf", parent: "feature/five" },
        { name: "feature/five", parent: "feature/four" },
        { name: "feature/four", parent: "feature/three" },
        { name: "feature/three", parent: "feature/two" },
        { name: "feature/two", parent: "feature/one" },
        { name: "feature/one", parent: "main" },
        { name: "main" },
      ],
    };

    expect(getSessionBranchTopologyRows(cycle).map(({ branch, depth }) => [branch.name, depth])).toEqual([
      ["feature/a", 1],
      ["feature/b", 0],
    ]);
    expect(getSessionBranchTopologyRows(deep).map(({ depth }) => depth)).toEqual([4, 4, 4, 3, 2, 1, 0]);
  });

  it("renders accessible ordered radio rows with connectors to their visible parents", () => {
    const output = renderSelector();
    const group = findElements(output, (element) => element.type === RadioGroup)[0];
    const options = branchOptions(output);
    const rails = findElements(
      output,
      (element) => element.props.className === "session-branch-topology-rail",
    );

    expect(group?.props).toMatchObject({
      "aria-label": "Local branches",
      value: TOPOLOGY.currentBranch,
    });
    expect(options.map((option) => [option.props["data-branch"], option.props["data-parent"]])).toEqual([
      ["feature/child", "feature/parent"],
      ["feature/parent", "main"],
      ["feature/sibling", "main"],
      [LONG_BRANCH, "feature/parent"],
      ["main", undefined],
    ]);
    expect(rails.map((rail) => rail.props["data-parent-direction"])).toEqual([
      "below",
      "below",
      "below",
      "above",
      "root",
    ]);
    expect(
      rails.map((rail) => (rail.props.style as Record<string, number>)["--branch-parent-distance"]),
    ).toEqual([1, 3, 2, 2, 0]);
    expect(options.map((option) => textContent(option))).toEqual(TOPOLOGY.branches.map(({ name }) => name));
  });

  it("makes the current branch selected and disabled without adding another current label", () => {
    const output = renderSelector();
    const group = findElements(output, (element) => element.type === RadioGroup)[0];
    const current = branchOptions(output)[0];

    expect(group?.props.value).toBe("feature/child");
    expect(current?.props).toMatchObject({
      value: "feature/child",
      "aria-label": "Current branch feature/child",
      disabled: true,
    });
    expect(textContent(current)).toBe("feature/child");
    expect(textContent(output)).not.toContain("Current feature/child");
  });

  it("keeps long branch names intact for assistive text while exposing an ellipsis title", () => {
    const output = renderSelector();
    const longOption = branchOptions(output).find((option) => textContent(option) === LONG_BRANCH);
    const name = findElements(
      longOption,
      (element) => element.props.className === "session-branch-option-name",
    )[0];

    expect(longOption?.props["aria-label"]).toBe(`Switch to branch ${LONG_BRANCH}, based on feature/parent`);
    expect(name?.props.title).toBe(LONG_BRANCH);
  });
});

describe("session branch selector interaction states", () => {
  it("uses a right desktop drawer and a swipeable bottom mobile sheet", () => {
    const desktop = renderSelector() as ReactElement<TestProps>;
    const mobile = renderSelector({ mobile: true }) as ReactElement<TestProps>;

    expect(desktop.type).toBe(Drawer);
    expect(desktop.props).toMatchObject({ swipeDirection: "right", showSwipeHandle: false });
    expect(mobile.props).toMatchObject({ swipeDirection: "down", showSwipeHandle: true });
  });

  it("autofocuses the accessible filter and forwards available branch selection", () => {
    const onQueryChange = vi.fn();
    const onSelectBranch = vi.fn();
    const output = renderSelector({ onQueryChange, onSelectBranch });
    const filter = findElements(output, (element) => element.type === Input)[0];
    const group = findElements(output, (element) => element.type === RadioGroup)[0];
    if (!filter || !group) throw new Error("Expected the filter and branch radio group");

    expect(filter.props).toMatchObject({
      id: "session-branch-filter",
      type: "search",
      autoFocus: true,
      placeholder: "Filter local branches",
    });
    (filter.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "sib" },
    });
    (group.props.onValueChange as (value: string) => void)("feature/sibling");
    expect(onQueryChange).toHaveBeenCalledWith("sib");
    expect(onSelectBranch).toHaveBeenCalledWith("feature/sibling");
  });

  it("keeps every checkout row disabled with explanatory copy when the session starts running", () => {
    const output = renderSelector({ running: true });

    expect(branchOptions(output).every((option) => option.props.disabled === true)).toBe(true);
    expect(textContent(output)).toContain(
      "This session is running. Wait for it to stop before switching branches.",
    );
    expect(findElements(output, (element) => element.props.role === "status")).not.toHaveLength(0);
  });

  it("announces loading and exact topology failures without fabricating fallback warnings", () => {
    const loading = renderSelector({ topology: null, loading: true });
    const failure = renderSelector({
      topology: null,
      loadError: "Graphite and Git could not read local branches",
    });

    expect(textContent(loading)).toContain("Reading local branch topology…");
    expect(findElements(loading, (element) => element.props.role === "status")).toHaveLength(1);
    expect(textContent(failure)).toContain("Graphite and Git could not read local branches");
    expect(findElements(failure, (element) => element.props.role === "alert")).toHaveLength(1);
    expect(textContent(renderSelector())).not.toMatch(/fallback|Graphite/i);
  });

  it("preserves no-match, pending, and exact checkout-error states in the open sheet", () => {
    const noMatch = renderSelector({ query: "does-not-exist" });
    const pending = renderSelector({ checkoutPending: "feature/sibling" });
    const exactError = "error: Your local changes would be overwritten by checkout";
    const failed = renderSelector({ query: "sibling", checkoutError: exactError });
    const pendingClose = findElements(
      pending,
      (element) =>
        isValidElement(element.props.render) &&
        textContent(element.props.render as ReactElement<TestProps>) === "Close",
    )[0]?.props.render as ReactElement<TestProps> | undefined;
    const failedClose = findElements(
      failed,
      (element) =>
        isValidElement(element.props.render) &&
        textContent(element.props.render as ReactElement<TestProps>) === "Close",
    )[0]?.props.render as ReactElement<TestProps> | undefined;

    expect(textContent(noMatch)).toContain("No local branches match “does-not-exist”.");
    expect(textContent(pending)).toContain("Switching to feature/sibling…");
    expect(branchOptions(pending).every((option) => option.props.disabled === true)).toBe(true);
    expect(pendingClose?.props.disabled).toBe(true);
    expect(textContent(failed)).toContain(exactError);
    expect(textContent(failedClose)).toBe("Close");
    expect(findElements(failed, (element) => element.props.role === "alert")[0]?.props.children).toBe(
      exactError,
    );
  });
});
