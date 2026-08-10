import type { CSSProperties } from "react";
import type { SessionBranchTopology, SessionBranchTopologyNode } from "@omp-remote/protocol";
import { Button } from "./ui/button.js";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  getResponsiveDrawerProps,
} from "./ui/drawer.js";
import { Input } from "./ui/input.js";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group.js";

const LOADING_ROWS = [0, 1, 2, 3] as const;

interface SessionBranchTopologyJoin {
  startLane: number;
  endLane: number;
  direction: "upper" | "lower";
}

export interface SessionBranchTopologyRow {
  branch: SessionBranchTopologyNode;
  index: number;
  lane: number;
  lanes: number[];
  upperLanes: number[];
  lowerLanes: number[];
  joins: SessionBranchTopologyJoin[];
}

export interface SessionBranchSelectorProps {
  open: boolean;
  mobile: boolean;
  currentBranch: string;
  topology: SessionBranchTopology | null;
  query: string;
  loading: boolean;
  loadError: string | null;
  checkoutPending: string | null;
  checkoutError: string | null;
  running: boolean;
  onQueryChange(query: string): void;
  onSelectBranch(branch: string): void;
  onOpenChange(open: boolean): void;
}

export function getSessionBranchTopologyRows(topology: SessionBranchTopology): SessionBranchTopologyRow[] {
  const indexByName = new Map(topology.branches.map((branch, index) => [branch.name, index]));
  const childrenByParent = new Map<string, SessionBranchTopologyNode[]>();
  for (const branch of topology.branches) {
    if (!branch.parent || !indexByName.has(branch.parent)) continue;
    const siblings = childrenByParent.get(branch.parent) ?? [];
    siblings.push(branch);
    childrenByParent.set(branch.parent, siblings);
  }

  const laneByName = new Map<string, number>();
  let nextLane = 0;
  const resolveLane = (branch: SessionBranchTopologyNode, path = new Set<string>()): number => {
    const existingLane = laneByName.get(branch.name);
    if (existingLane !== undefined) return existingLane;
    if (path.has(branch.name)) {
      const cycleLane = nextLane++;
      laneByName.set(branch.name, cycleLane);
      return cycleLane;
    }

    const parentIndex = branch.parent ? indexByName.get(branch.parent) : undefined;
    if (parentIndex === undefined) {
      const rootLane = nextLane++;
      laneByName.set(branch.name, rootLane);
      return rootLane;
    }

    path.add(branch.name);
    const parent = topology.branches[parentIndex];
    if (!parent) {
      const rootLane = nextLane++;
      laneByName.set(branch.name, rootLane);
      path.delete(branch.name);
      return rootLane;
    }
    const parentLane = resolveLane(parent, path);
    path.delete(branch.name);
    const latestSibling = childrenByParent.get(parent.name)?.[0];
    const lane = latestSibling?.name === branch.name ? parentLane : nextLane++;
    laneByName.set(branch.name, lane);
    return lane;
  };

  for (const branch of topology.branches) resolveLane(branch);

  const laneCount = Math.max(nextLane, 1);
  const upperLanes = topology.branches.map(() => new Set<number>());
  const lowerLanes = topology.branches.map(() => new Set<number>());
  const joins = topology.branches.map(() => [] as SessionBranchTopologyJoin[]);

  topology.branches.forEach((branch, childIndex) => {
    const parentIndex = branch.parent ? indexByName.get(branch.parent) : undefined;
    if (parentIndex === undefined) return;
    const childLane = laneByName.get(branch.name) ?? 0;
    const parentLane = laneByName.get(branch.parent ?? "") ?? 0;
    const firstIndex = Math.min(childIndex, parentIndex);
    const lastIndex = Math.max(childIndex, parentIndex);

    const sharedLane = childLane === parentLane;
    if (childIndex < parentIndex) {
      lowerLanes[childIndex]?.add(childLane);
      if (sharedLane) upperLanes[parentIndex]?.add(childLane);
    } else {
      upperLanes[childIndex]?.add(childLane);
      if (sharedLane) lowerLanes[parentIndex]?.add(childLane);
    }
    for (let index = firstIndex + 1; index < lastIndex; index += 1) {
      upperLanes[index]?.add(childLane);
      lowerLanes[index]?.add(childLane);
    }
    if (!sharedLane) {
      joins[parentIndex]?.push({
        startLane: Math.min(childLane, parentLane),
        endLane: Math.max(childLane, parentLane),
        direction: childIndex < parentIndex ? "upper" : "lower",
      });
    }
  });

  const lanes = Array.from({ length: laneCount }, (_, lane) => lane);
  return topology.branches.map((branch, index) => ({
    branch,
    index,
    lane: laneByName.get(branch.name) ?? 0,
    lanes,
    upperLanes: [...(upperLanes[index] ?? [])],
    lowerLanes: [...(lowerLanes[index] ?? [])],
    joins: joins[index] ?? [],
  }));
}

export function filterSessionBranchTopologyRows(
  topology: SessionBranchTopology,
  query: string,
): SessionBranchTopologyRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return getSessionBranchTopologyRows(topology);
  return getSessionBranchTopologyRows({
    ...topology,
    branches: topology.branches.filter(({ name }) => name.toLocaleLowerCase().includes(normalizedQuery)),
  });
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function SessionBranchSelector({
  open,
  mobile,
  currentBranch,
  topology,
  query,
  loading,
  loadError,
  checkoutPending,
  checkoutError,
  running,
  onQueryChange,
  onSelectBranch,
  onOpenChange,
}: SessionBranchSelectorProps) {
  const rows = topology ? filterSessionBranchTopologyRows(topology, query) : [];
  const checkoutDisabled = running || checkoutPending !== null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} {...getResponsiveDrawerProps(mobile)}>
      <DrawerContent className="session-branch-selector">
        <DrawerHeader className="session-branch-selector-header">
          <div>
            <DrawerTitle>Switch branch</DrawerTitle>
            <DrawerDescription>Choose a local branch for this session.</DrawerDescription>
          </div>
          <DrawerClose
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close branch selector"
                disabled={checkoutPending !== null}
              />
            }
          >
            <CloseIcon />
          </DrawerClose>
        </DrawerHeader>

        <div className="session-branch-selector-body" aria-busy={loading || checkoutPending !== null}>
          {topology ? (
            <label className="session-branch-filter" htmlFor="session-branch-filter">
              <span className="sr-only">Filter local branches</span>
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4 4" />
              </svg>
              <Input
                id="session-branch-filter"
                type="search"
                value={query}
                placeholder="Filter local branches"
                autoComplete="off"
                autoFocus
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </label>
          ) : null}

          {running ? (
            <p className="session-branch-guard" role="status">
              This session is running. Wait for it to stop before switching branches.
            </p>
          ) : null}
          {checkoutPending ? (
            <p className="session-branch-pending" role="status">
              Switching to <strong>{checkoutPending}</strong>…
            </p>
          ) : null}
          {checkoutError ? (
            <p className="session-branch-error" role="alert">
              {checkoutError}
            </p>
          ) : null}

          {loading && !topology ? (
            <div className="session-branch-loading" role="status">
              <span>Reading local branch topology…</span>
              <div aria-hidden="true">
                {LOADING_ROWS.map((row) => (
                  <span className="session-branch-loading-row" key={row} />
                ))}
              </div>
            </div>
          ) : loadError ? (
            <div className="session-branch-source-error" role="alert">
              <strong>Local branches unavailable</strong>
              <p>{loadError}</p>
            </div>
          ) : topology ? (
            rows.length > 0 ? (
              <RadioGroup
                className="session-branch-list"
                aria-label="Local branches"
                value={currentBranch}
                disabled={checkoutDisabled}
                onValueChange={(branch) => {
                  if (branch !== currentBranch) onSelectBranch(branch);
                }}
              >
                {rows.map(({ branch, lane, lanes, upperLanes, lowerLanes, joins }) => {
                  const current = branch.name === currentBranch;
                  const branchDisabled = checkoutDisabled || current;
                  const trunk = !branch.parent;
                  return (
                    <RadioGroupItem
                      className={current ? "session-branch-option selected" : "session-branch-option"}
                      value={branch.name}
                      data-branch={branch.name}
                      data-parent={branch.parent}
                      data-lane={lane}
                      aria-label={
                        current
                          ? `Current branch ${branch.name}`
                          : branch.parent
                            ? `Switch to branch ${branch.name}, based on ${branch.parent}`
                            : `Switch to branch ${branch.name}`
                      }
                      disabled={branchDisabled}
                      key={branch.name}
                    >
                      <span
                        className="session-branch-graph"
                        style={{ "--branch-lane-count": lanes.length } as CSSProperties}
                        aria-hidden="true"
                      >
                        {joins.map((join) => (
                          <span
                            className="session-branch-node-join"
                            data-start-lane={join.startLane}
                            data-end-lane={join.endLane}
                            data-direction={join.direction}
                            data-color={join.endLane % 5}
                            style={
                              {
                                "--branch-join-start": join.startLane,
                                "--branch-join-span": join.endLane - join.startLane,
                              } as CSSProperties
                            }
                            key={`${join.startLane}-${join.endLane}`}
                          />
                        ))}
                        {lanes.map((graphLane) => (
                          <span
                            className="session-branch-node-lane"
                            data-color={graphLane % 5}
                            key={graphLane}
                          >
                            {upperLanes.includes(graphLane) ? (
                              <span
                                className="session-branch-node-line"
                                data-kind="upper"
                                data-lane={graphLane}
                              />
                            ) : null}
                            {graphLane === lane ? (
                              <span className="session-branch-node-dot" data-selected={current} />
                            ) : null}
                            {lowerLanes.includes(graphLane) ? (
                              <span
                                className="session-branch-node-line"
                                data-kind="lower"
                                data-lane={graphLane}
                              />
                            ) : null}
                          </span>
                        ))}
                      </span>
                      <span className="session-branch-row-content">
                        <span className="session-branch-option-name" title={branch.name}>
                          {branch.name}
                        </span>
                        {trunk ? (
                          <span className="session-branch-trunk-label" aria-hidden="true">
                            (trunk)
                          </span>
                        ) : null}
                      </span>
                    </RadioGroupItem>
                  );
                })}
              </RadioGroup>
            ) : (
              <div className="session-branch-empty" role="status">
                <strong>No matching branches</strong>
                <p>No local branches match “{query.trim()}”.</p>
              </div>
            )
          ) : null}
        </div>

        <DrawerFooter className="session-branch-selector-footer">
          <DrawerClose
            render={
              <Button type="button" variant="outline" disabled={checkoutPending !== null}>
                Close
              </Button>
            }
          />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
