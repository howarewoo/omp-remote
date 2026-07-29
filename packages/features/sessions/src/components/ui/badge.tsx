import type { HTMLAttributes } from "react";
import { cn } from "./utils.js";

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="badge" className={cn("ui-badge", className)} {...props} />;
}
