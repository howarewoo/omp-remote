import type { ReactNode } from "react";
import { DashboardIcon as BaseDashboardIcon } from "./session-header.js";

export type DashboardIconName =
  | "alert"
  | "arrow-left"
  | "bell"
  | "check"
  | "close"
  | "down"
  | "filter"
  | "laptop"
  | "moon"
  | "plus"
  | "power"
  | "refresh"
  | "search"
  | "send"
  | "stop"
  | "sun"
  | "trash"
  | "up";

const EXTRA_PATHS: Record<string, ReactNode> = {
  alert: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </>
  ),
  "arrow-left": (
    <>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  filter: <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />,
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </>
  ),
};

export function DashboardIcon({ name }: { name: DashboardIconName }) {
  if (name in EXTRA_PATHS) {
    return (
      <svg
        className="icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {EXTRA_PATHS[name]}
      </svg>
    );
  }
  return <BaseDashboardIcon name={name as Parameters<typeof BaseDashboardIcon>[0]["name"]} />;
}
