import type { DashboardProps } from "./dashboard-props.js";
import { DashboardContent } from "./dashboard-content.js";
import { SidebarProvider } from "./ui/sidebar.js";

export * from "./dashboard-exports.js";
export type { DashboardProps } from "./dashboard-props.js";

export function Dashboard(props: DashboardProps) {
  return (
    <SidebarProvider>
      <DashboardContent {...props} />
    </SidebarProvider>
  );
}

