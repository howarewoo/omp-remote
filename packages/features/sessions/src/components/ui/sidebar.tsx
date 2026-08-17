import { Dialog } from "@base-ui/react/dialog";
import {
  type ComponentProps,
  type CSSProperties,
  createContext,
  type Dispatch,
  type HTMLAttributes,
  type SetStateAction,
  type Touch as ReactTouch,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "./button.js";
import { isSidebarCloseSwipe, isSidebarOpenSwipe } from "./sidebar-swipe.js";
import { useIsMobile } from "./use-mobile.js";
import { cn } from "./utils.js";

const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = "23rem";
const SIDEBAR_WIDTH_MOBILE = "23.5rem";
const SIDEBAR_WIDTH_ICON = "3.75rem";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

type SidebarContextValue = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  openMobile: boolean;
  setOpenMobile: Dispatch<SetStateAction<boolean>>;
  isMobile: boolean;
  toggleSidebar(): void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

type SwipeStart = {
  identifier: number;
  x: number;
  y: number;
};

function isIosStandalonePwa(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isStandalonePwa(): boolean {
  return (
    isIosStandalonePwa() ||
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches)
  );
}

export function useSidebar(): SidebarContextValue {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider.");
  return context;
}

type SidebarProviderProps = ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
};

export function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  className,
  style,
  children,
  ...props
}: SidebarProviderProps) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = useState(false);
  const swipeStartRef = useRef<SwipeStart | null>(null);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = openProp ?? internalOpen;

  const setOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      const nextOpen = typeof value === "function" ? value(open) : value;
      if (onOpenChange) onOpenChange(nextOpen);
      else setInternalOpen(nextOpen);
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${nextOpen}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [onOpenChange, open],
  );

  const toggleSidebar = useCallback(() => {
    if (isMobile) setOpenMobile((current) => !current);
    else setOpen((current) => !current);
  }, [isMobile, setOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  useEffect(() => {
    if (!isMobile || openMobile || !isIosStandalonePwa()) return;

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches.item(0) : null;
      swipeStartRef.current = touch
        ? { identifier: touch.identifier, x: touch.clientX, y: touch.clientY }
        : null;
    };
    const handleTouchEnd = (event: TouchEvent) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      if (!start) return;

      let end: Touch | null = null;
      for (let index = 0; index < event.changedTouches.length; index += 1) {
        const touch = event.changedTouches.item(index);
        if (touch?.identifier === start.identifier) {
          end = touch;
          break;
        }
      }

      if (
        end &&
        isSidebarOpenSwipe({
          startX: start.x,
          startY: start.y,
          endX: end.clientX,
          endY: end.clientY,
        })
      ) {
        setOpenMobile(true);
      }
    };
    const cancelSwipe = () => {
      swipeStartRef.current = null;
    };

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", cancelSwipe, { passive: true });
    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", cancelSwipe);
    };
  }, [isMobile, openMobile]);

  const state = open ? "expanded" : "collapsed";
  const value = useMemo<SidebarContextValue>(
    () => ({
      state,
      open,
      setOpen,
      openMobile,
      setOpenMobile,
      isMobile,
      toggleSidebar,
    }),
    [isMobile, open, openMobile, setOpen, state, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        className={cn("sidebar-provider", className)}
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-mobile": SIDEBAR_WIDTH_MOBILE,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            ...style,
          } as CSSProperties
        }
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

type SidebarProps = ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
};

export function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  className,
  children,
  onTouchCancel,
  onTouchEnd,
  onTouchStart,
  "aria-label": ariaLabel = "Sessions",
  ...props
}: SidebarProps) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();
  const closeSwipeStartRef = useRef<SwipeStart | null>(null);

  const handleCloseSwipeStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    onTouchStart?.(event);
    if (event.defaultPrevented || !isStandalonePwa()) {
      closeSwipeStartRef.current = null;
      return;
    }

    const touch = event.touches.length === 1 ? event.touches.item(0) : null;
    closeSwipeStartRef.current = touch
      ? { identifier: touch.identifier, x: touch.clientX, y: touch.clientY }
      : null;
  };
  const handleCloseSwipeEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    onTouchEnd?.(event);
    const start = closeSwipeStartRef.current;
    closeSwipeStartRef.current = null;
    if (event.defaultPrevented || !start) return;

    let end: ReactTouch | null = null;
    for (let index = 0; index < event.changedTouches.length; index += 1) {
      const touch = event.changedTouches.item(index);
      if (touch?.identifier === start.identifier) {
        end = touch;
        break;
      }
    }

    if (
      end &&
      isSidebarCloseSwipe(
        {
          startX: start.x,
          startY: start.y,
          endX: end.clientX,
          endY: end.clientY,
        },
        side,
      )
    ) {
      setOpenMobile(false);
    }
  };
  const cancelCloseSwipe = (event: ReactTouchEvent<HTMLDivElement>) => {
    onTouchCancel?.(event);
    closeSwipeStartRef.current = null;
  };

  if (collapsible === "none") {
    return (
      <aside
        data-sidebar="sidebar"
        data-slot="sidebar"
        className={cn("sidebar sidebar-static", className)}
        aria-label={ariaLabel}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        {...props}
      >
        {children}
      </aside>
    );
  }

  if (isMobile) {
    return (
      <Dialog.Root open={openMobile} onOpenChange={setOpenMobile}>
        <Dialog.Portal>
          <Dialog.Backdrop data-slot="sidebar-backdrop" className="sidebar-backdrop" />
          <Dialog.Popup
            data-sidebar="sidebar"
            data-slot="sidebar"
            data-mobile="true"
            data-side={side}
            className={cn("sidebar-sheet", className)}
            onTouchStart={handleCloseSwipeStart}
            onTouchEnd={handleCloseSwipeEnd}
            onTouchCancel={cancelCloseSwipe}
            {...props}
          >
            <Dialog.Title className="sr-only">{ariaLabel}</Dialog.Title>
            <Dialog.Description className="sr-only">Displays the session sidebar.</Dialog.Description>
            <aside className="sidebar" aria-label={ariaLabel}>
              {children}
            </aside>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <div
      data-slot="sidebar"
      className="sidebar-root"
      data-state={state}
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-variant={variant}
      data-side={side}
    >
      <div data-slot="sidebar-gap" className="sidebar-gap" />
      <div
        data-slot="sidebar-container"
        data-side={side}
        className={cn("sidebar-container", className)}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        {...props}
      >
        <aside data-sidebar="sidebar" data-slot="sidebar-inner" className="sidebar" aria-label={ariaLabel}>
          {children}
        </aside>
      </div>
    </div>
  );
}

export function SidebarHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("sidebar-header", className)}
      {...props}
    />
  );
}

export function SidebarContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn("sidebar-content", className)}
      {...props}
    />
  );
}

export function SidebarFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("sidebar-footer", className)}
      {...props}
    />
  );
}

export function SidebarInset({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <main data-slot="sidebar-inset" className={cn("sidebar-inset", className)} {...props} />;
}

export function SidebarTrigger({
  className,
  onClick,
  ...props
}: Omit<ComponentProps<typeof Button>, "children">) {
  const { isMobile, open, openMobile, toggleSidebar } = useSidebar();
  const expanded = isMobile ? openMobile : open;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      className={cn("sidebar-trigger", className)}
      aria-label={expanded ? "Close session sidebar" : "Open session sidebar"}
      aria-expanded={expanded}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="1" />
        <path d="M9 4v16M13 9h5M13 13h5" />
      </svg>
      <span className="sr-only">Toggle sidebar</span>
    </Button>
  );
}

export function SidebarRail({ className, ...props }: ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar();

  return (
    <button
      type="button"
      data-sidebar="rail"
      data-slot="sidebar-rail"
      className={cn("sidebar-rail", className)}
      aria-label="Toggle session sidebar"
      title="Toggle session sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      {...props}
    />
  );
}
