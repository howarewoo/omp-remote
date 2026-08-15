import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./utils.js";

export function TooltipProvider(props: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider {...props} />;
}

export function TooltipRoot(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root {...props} />;
}

export function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipPortal(props: TooltipPrimitive.Portal.Props) {
  return <TooltipPrimitive.Portal {...props} />;
}

export function TooltipPositioner({
  side = "right",
  sideOffset = 8,
  ...props
}: TooltipPrimitive.Positioner.Props) {
  return (
    <TooltipPrimitive.Positioner
      data-slot="tooltip-positioner"
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export function TooltipPopup({ className, ...props }: TooltipPrimitive.Popup.Props) {
  return (
    <TooltipPrimitive.Popup
      data-slot="tooltip-popup"
      className={
        typeof className === "function"
          ? (state) => cn("ui-tooltip", className(state))
          : cn("ui-tooltip", className)
      }
      {...props}
    />
  );
}

export interface TooltipProps extends Omit<TooltipPrimitive.Root.Props, "children"> {
  content: ReactNode;
  children: ReactElement;
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: number;
  className?: string;
  disabled?: boolean;
}

export function Tooltip({
  content,
  children,
  side = "right",
  sideOffset = 8,
  className,
  disabled = false,
  ...props
}: TooltipProps) {
  if (disabled || !content) return <>{children}</>;

  return (
    <TooltipRoot {...props}>
      <TooltipTrigger render={children} />
      <TooltipPortal>
        <TooltipPositioner side={side} sideOffset={sideOffset}>
          <TooltipPopup className={className}>{content}</TooltipPopup>
        </TooltipPositioner>
      </TooltipPortal>
    </TooltipRoot>
  );
}
