import type { HTMLAttributes } from "react";
import { cn } from "./utils.js";

export function Separator({ className, ...props }: HTMLAttributes<HTMLHRElement>) {
  return <hr data-slot="separator" className={cn("ui-separator", className)} {...props} />;
}
