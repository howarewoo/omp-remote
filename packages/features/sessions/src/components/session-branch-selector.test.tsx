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
  it("keeps daemon order while assigning only the latest child to its parent's stack lane", () => {
    const rows = getSessionBranchTopologyRows(TOPOLOGY);

    expect(rows.map(({ branch, lane }) => [branch.name, lane])).toEqual([
      ["feature/child", 0],
      ["feature/parent", 0],
      ["feature/sibling", 1],
      [LONG_BRANCH, 2],
      ["main", 0],
    ]);
    const laneByBranch = new Map(rows.map(({ branch, lane }) => [branch.name, lane]));
    expect(
      rows.every(({ branch, lane }) => !branch.parent || lane >= (laneByBranch.get(branch.parent) ?? lane)),
    ).toBe(true);
    expect(rows.map(({ upperLanes, lowerLanes }) => [upperLanes, lowerLanes])).toEqual([
      [[], [0]],
      [[0], [0]],
      [
        [0, 2],
        [0, 1, 2],
      ],
      [
        [0, 1, 2],
        [0, 1],
      ],
      [[0], []],
    ]);
    expect(rows.map(({ joins }) => joins)).toEqual([
      [],
      [{ startLane: 0, endLane: 2, direction: "lower" }],
      [],
      [],
      [{ startLane: 0, endLane: 1, direction: "upper" }],
    ]);
    expect(filterSessionBranchTopologyRows(TOPOLOGY, "FEATURE/").map(({ branch }) => branch.name)).toEqual([
      "feature/child",
      "feature/parent",
      "feature/sibling",
      LONG_BRANCH,
    ]);
    expect(
      filterSessionBranchTopologyRows(TOPOLOGY, "sibling").map(({ branch, lane }) => [branch.name, lane]),
    ).toEqual([["feature/sibling", 0]]);
  });

  it("renders siblings on disconnected parallel lanes with only the latest child stacked", () => {
    const output = renderSelector();
    const group = findElements(output, (element) => element.type === RadioGroup)[0];
    const options = branchOptions(output);
    const graphs = findElements(output, (element) => element.props.className === "session-branch-graph");
    const joins = findElements(output, (element) => element.props.className === "session-branch-node-join");
    const dots = findElements(output, (element) => element.props.className === "session-branch-node-dot");
    const names = findElements(output, (element) => element.props.className === "session-branch-option-name");
    const trunkLabel = findElements(
      output,
      (element) => element.props.className === "session-branch-trunk-label",
    )[0];

    expect(group?.props).toMatchObject({
      "aria-label": "Local branches",
      value: TOPOLOGY.currentBranch,
    });
    expect(
      options.map((option) => [
        option.props["data-branch"],
        option.props["data-parent"],
        option.props["data-lane"],
      ]),
    ).toEqual([
      ["feature/child", "feature/parent", 0],
      ["feature/parent", "main", 0],
      ["feature/sibling", "main", 1],
      [LONG_BRANCH, "feature/parent", 2],
      ["main", undefined, 0],
    ]);
    expect(
      graphs.map((graph) =>
        findElements(graph, (element) => element.props.className === "session-branch-node-line").map(
          (line) => [line.props["data-kind"], line.props["data-lane"]],
        ),
      ),
    ).toEqual([
      [["lower", 0]],
      [
        ["upper", 0],
        ["lower", 0],
      ],
      [
        ["upper", 0],
        ["lower", 0],
        ["lower", 1],
        ["upper", 2],
        ["lower", 2],
      ],
      [
        ["upper", 0],
        ["lower", 0],
        ["upper", 1],
        ["lower", 1],
        ["upper", 2],
      ],
      [["upper", 0]],
    ]);
    expect(
      joins.map((join) => [
        join.props["data-start-lane"],
        join.props["data-end-lane"],
        join.props["data-direction"],
        join.props["data-color"],
      ]),
    ).toEqual([
      [0, 2, "lower", 2],
      [0, 1, "upper", 1],
    ]);
    expect(dots.map((dot) => dot.props["data-selected"])).toEqual([true, false, false, false, false]);
    expect(names.map((name) => textContent(name))).toEqual(TOPOLOGY.branches.map(({ name }) => name));
    expect(trunkLabel?.props["aria-hidden"]).toBe("true");
    expect(textContent(trunkLabel)).toBe("(trunk)");
    expect(textContent(options.at(-1))).toBe("main(trunk)");
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
