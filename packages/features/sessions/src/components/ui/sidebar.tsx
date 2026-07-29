import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./button.js";
import { cn } from "./utils.js";

type SidebarContextValue = {
  collapsed: boolean;
  mobile: boolean;
  setCollapsed(collapsed: boolean): void;
  closeMobile(): void;
  toggle(): void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("Sidebar components must be used inside SidebarProvider");
  return context;
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const mediaQuery = useRef(window.matchMedia("(max-width: 760px)"));
  const [mobile, setMobile] = useState(mediaQuery.current.matches);
  const [collapsed, setCollapsed] = useState(mediaQuery.current.matches);

  useEffect(() => {
    const query = mediaQuery.current;
    const handleChange = (event: MediaQueryListEvent) => {
      setMobile(event.matches);
      setCollapsed(event.matches);
    };
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  const value: SidebarContextValue = {
    collapsed,
    mobile,
    setCollapsed,
    closeMobile: () => {
      if (mobile) setCollapsed(true);
    },
    toggle: () => setCollapsed((current) => !current),
  };

  return (
    <SidebarContext.Provider value={value}>
      <div data-slot="sidebar-wrapper" className="sidebar-provider" data-sidebar-collapsed={collapsed}>
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  const { collapsed, mobile, setCollapsed } = useSidebar();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !mobile) return;
    if (!collapsed && !dialog.open) dialog.showModal();
    if (collapsed && dialog.open) dialog.close();
  }, [collapsed, mobile]);

  if (!mobile) {
    return (
      <aside data-slot="sidebar" className={cn("sidebar", className)} aria-label="Sessions" {...props}>
        {children}
      </aside>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      data-slot="sidebar-sheet"
      className="sidebar-sheet"
      aria-label="Sessions"
      onCancel={(event) => {
        event.preventDefault();
        setCollapsed(true);
      }}
      onClose={() => setCollapsed(true)}
    >
      <aside data-slot="sidebar" className={cn("sidebar", className)} {...props}>
        {children}
      </aside>
    </dialog>
  );
}

export function SidebarHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-header" className={cn("sidebar-header", className)} {...props} />;
}

export function SidebarContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-content" className={cn("sidebar-content", className)} {...props} />;
}

export function SidebarFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-footer" className={cn("sidebar-footer", className)} {...props} />;
}

export function SidebarInset({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <main data-slot="sidebar-inset" className={cn("sidebar-inset", className)} {...props} />;
}

export function SidebarTrigger({ className, ...props }: Omit<ComponentProps<typeof Button>, "children">) {
  const { collapsed, toggle } = useSidebar();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("sidebar-trigger", className)}
      aria-label={collapsed ? "Open session sidebar" : "Collapse session sidebar"}
      aria-expanded={!collapsed}
      onClick={toggle}
      {...props}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="1" />
        <path d="M9 4v16M13 9h5M13 13h5" />
      </svg>
    </Button>
  );
}
