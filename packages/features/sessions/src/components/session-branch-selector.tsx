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

  const chainByName = new Map<string, string>();
  const resolveChain = (branch: SessionBranchTopologyNode, path = new Set<string>()): string => {
    const existingChain = chainByName.get(branch.name);
    if (existingChain) return existingChain;
    if (path.has(branch.name)) {
      chainByName.set(branch.name, branch.name);
      return branch.name;
    }

    const parentIndex = branch.parent ? indexByName.get(branch.parent) : undefined;
    const parent = parentIndex === undefined ? undefined : topology.branches[parentIndex];
    const continuesParent = parent && childrenByParent.get(parent.name)?.[0]?.name === branch.name;
    if (!parent || !continuesParent) {
      chainByName.set(branch.name, branch.name);
      return branch.name;
    }

    path.add(branch.name);
    const chain = resolveChain(parent, path);
    path.delete(branch.name);
    chainByName.set(branch.name, chain);
    return chain;
  };

  for (const branch of topology.branches) resolveChain(branch);

  const chainIntervals = new Map<string, { start: number; end: number }>();
  const includeInChain = (chain: string, index: number) => {
    const interval = chainIntervals.get(chain);
    if (interval) {
      interval.start = Math.min(interval.start, index);
      interval.end = Math.max(interval.end, index);
    } else {
      chainIntervals.set(chain, { start: index, end: index });
    }
  };
  const parentChainByChain = new Map<string, string>();

  topology.branches.forEach((branch, index) => {
    const chain = chainByName.get(branch.name) ?? branch.name;
    includeInChain(chain, index);

    const parentIndex = branch.parent ? indexByName.get(branch.parent) : undefined;
    if (parentIndex === undefined || !branch.parent) return;
    const parentChain = chainByName.get(branch.parent) ?? branch.parent;
    if (parentChain === chain) return;
    includeInChain(parentChain, index);
    parentChainByChain.set(chain, parentChain);
  });

  const laneIntervals: Array<Array<{ start: number; end: number }>> = [];
  const laneByChain = new Map<string, number>();
  const resolveChainLane = (chain: string, path = new Set<string>()): number => {
    const existingLane = laneByChain.get(chain);
    if (existingLane !== undefined) return existingLane;

    const parentChain = parentChainByChain.get(chain);
    let firstLane = 0;
    if (parentChain && parentChain !== chain && !path.has(chain)) {
      path.add(chain);
      firstLane = resolveChainLane(parentChain, path) + 1;
      path.delete(chain);
    }

    const interval = chainIntervals.get(chain) ?? { start: 0, end: 0 };
    let lane = firstLane;
    while (
      laneIntervals[lane]?.some(
        (occupied) => interval.start <= occupied.end && occupied.start <= interval.end,
      )
    ) {
      lane += 1;
    }
    const intervalsForLane = laneIntervals[lane] ?? [];
    intervalsForLane.push(interval);
    laneIntervals[lane] = intervalsForLane;
    laneByChain.set(chain, lane);
    return lane;
  };

  for (const branch of topology.branches) {
    resolveChainLane(chainByName.get(branch.name) ?? branch.name);
  }

  const laneByName = new Map(
    topology.branches.map((branch) => {
      const chain = chainByName.get(branch.name) ?? branch.name;
      return [branch.name, laneByChain.get(chain) ?? 0] as const;
    }),
  );
  const upperLanes = topology.branches.map(() => new Set<number>());
  const lowerLanes = topology.branches.map(() => new Set<number>());
  const joins = topology.branches.map(() => [] as SessionBranchTopologyJoin[]);

  topology.branches.forEach((branch, childIndex) => {
    const parentIndex = branch.parent ? indexByName.get(branch.parent) : undefined;
    if (parentIndex === undefined || !branch.parent) return;
    const childLane = laneByName.get(branch.name) ?? 0;
    const parentLane = laneByName.get(branch.parent) ?? 0;
    const firstIndex = Math.min(childIndex, parentIndex);
    const lastIndex = Math.max(childIndex, parentIndex);

    if (childIndex < parentIndex) {
      lowerLanes[childIndex]?.add(parentLane);
      upperLanes[parentIndex]?.add(parentLane);
    } else {
      upperLanes[childIndex]?.add(parentLane);
      lowerLanes[parentIndex]?.add(parentLane);
    }
    for (let index = firstIndex + 1; index < lastIndex; index += 1) {
      upperLanes[index]?.add(parentLane);
      lowerLanes[index]?.add(parentLane);
    }
    if (childLane !== parentLane) {
      joins[childIndex]?.push({
        startLane: Math.min(childLane, parentLane),
        endLane: Math.max(childLane, parentLane),
        direction: childIndex < parentIndex ? "lower" : "upper",
      });
    }
  });

  return topology.branches.map((branch, index) => {
    const lane = laneByName.get(branch.name) ?? 0;
    const rowUpperLanes = [...(upperLanes[index] ?? [])];
    const rowLowerLanes = [...(lowerLanes[index] ?? [])];
    const rowJoins = joins[index] ?? [];
    const lastLane = Math.max(
      lane,
      ...rowUpperLanes,
      ...rowLowerLanes,
      ...rowJoins.flatMap(({ startLane, endLane }) => [startLane, endLane]),
    );
    return {
      branch,
      index,
      lane,
      lanes: Array.from({ length: lastLane + 1 }, (_, graphLane) => graphLane),
      upperLanes: rowUpperLanes,
      lowerLanes: rowLowerLanes,
      joins: rowJoins,
    };
  });
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
              <section className="session-branch-list-scroll" aria-label="Scrollable branch graph">
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
                              data-color={join.startLane % 5}
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
              </section>
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
