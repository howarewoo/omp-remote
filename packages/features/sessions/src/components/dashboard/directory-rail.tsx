import type { ReactNode } from "react";
import type { DirectoryRailEntry } from "../dashboard-actions.js";
import { Button } from "../ui/button.js";
import { Tooltip } from "../ui/tooltip.js";
import { cn } from "../ui/utils.js";

export interface DirectoryRailProps {
  entries: DirectoryRailEntry[];
  selectedDirectory: string | null;
  onSelectDirectory(cwd: string | null): void;
  className?: string;
}

export function DirectoryRail({
  entries,
  selectedDirectory,
  onSelectDirectory,
  className,
}: DirectoryRailProps) {
  return (
    <nav className={cn("directory-rail", className)} aria-label="Filter sessions by directory">
      <div className="directory-rail-scroll">
        <ul className="directory-rail-list">
          {entries.map((entry) => {
            const isSelected =
              entry.cwd === null ? selectedDirectory === null : selectedDirectory === entry.cwd;
            return (
              <li key={entry.id} className="directory-rail-item-wrapper">
                <Tooltip content={entry.tooltip} side="right" sideOffset={8}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn("directory-rail-button", isSelected && "directory-rail-button-selected")}
                    aria-current={isSelected ? "true" : undefined}
                    aria-label={entry.label}
                    onClick={() => onSelectDirectory(entry.cwd)}
                  >
                    <span className="directory-rail-marker" aria-hidden="true" />
                    <span className="directory-rail-avatar">
                      {entry.cwd === null ? (
                        <DirectoryAllIcon />
                      ) : (
                        <span className="directory-rail-initials">{entry.initials}</span>
                      )}
                    </span>
                    {entry.count > 1 ? (
                      <span className="directory-rail-count-badge" aria-hidden="true">
                        {entry.count > 99 ? "99+" : entry.count}
                      </span>
                    ) : null}
                  </Button>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

function DirectoryAllIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="directory-rail-all-icon"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
