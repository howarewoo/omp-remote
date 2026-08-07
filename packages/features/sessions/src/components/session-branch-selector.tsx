import type { SessionBranchTopology, SessionBranchTopologyNode } from "@omp-remote/protocol";
import type { CSSProperties } from "react";
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

const TOPOLOGY_DEPTH_LIMIT = 4;
const LOADING_ROWS = [0, 1, 2, 3] as const;

export interface SessionBranchTopologyRow {
  branch: SessionBranchTopologyNode;
  depth: number;
  index: number;
  parentIndex: number | null;
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
  const branchIndex = new Map(topology.branches.map((branch, index) => [branch.name, index]));
  const depthByName = new Map<string, number>();

  for (const branch of topology.branches) {
    if (depthByName.has(branch.name)) continue;
    const path: SessionBranchTopologyNode[] = [];
    const visited = new Set<string>();
    let cursor: SessionBranchTopologyNode | undefined = branch;
    let depth = -1;

    while (cursor) {
      const knownDepth = depthByName.get(cursor.name);
      if (knownDepth !== undefined) {
        depth = knownDepth;
        break;
      }
      if (visited.has(cursor.name)) break;
      visited.add(cursor.name);
      path.push(cursor);
      const parentIndex: number | undefined = cursor.parent ? branchIndex.get(cursor.parent) : undefined;
      cursor = parentIndex === undefined ? undefined : topology.branches[parentIndex];
    }

    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth = Math.min(depth + 1, TOPOLOGY_DEPTH_LIMIT);
      depthByName.set((path[index] as SessionBranchTopologyNode).name, depth);
    }
  }

  return topology.branches.map((branch, index) => ({
    branch,
    depth: depthByName.get(branch.name) ?? 0,
    index,
    parentIndex: branch.parent ? (branchIndex.get(branch.parent) ?? null) : null,
  }));
}

export function filterSessionBranchTopologyRows(
  topology: SessionBranchTopology,
  query: string,
): SessionBranchTopologyRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const rows = getSessionBranchTopologyRows(topology);
  if (!normalizedQuery) return rows;
  return rows.filter(({ branch }) => branch.name.toLocaleLowerCase().includes(normalizedQuery));
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
  const rowIndexByBranch = new Map(rows.map(({ branch }, index) => [branch.name, index]));
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
                {rows.map(({ branch, depth }, index) => {
                  const current = branch.name === currentBranch;
                  const branchDisabled = checkoutDisabled || current;
                  const parentIndex = branch.parent ? rowIndexByBranch.get(branch.parent) : undefined;
                  const parentRow = parentIndex === undefined ? undefined : rows[parentIndex];
                  const parentDirection =
                    parentIndex === undefined ? "root" : parentIndex < index ? "above" : "below";
                  const style = {
                    "--branch-depth": depth,
                    "--branch-parent-depth": parentRow?.depth ?? depth,
                    "--branch-parent-distance": parentIndex === undefined ? 0 : Math.abs(parentIndex - index),
                  } as CSSProperties;
                  return (
                    <RadioGroupItem
                      className={current ? "session-branch-option selected" : "session-branch-option"}
                      value={branch.name}
                      data-branch={branch.name}
                      data-parent={branch.parent}
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
                        className="session-branch-topology-rail"
                        data-parent-direction={parentDirection}
                        style={style}
                        aria-hidden="true"
                      >
                        <span />
                      </span>
                      <span className="session-branch-option-name" title={branch.name}>
                        {branch.name}
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
