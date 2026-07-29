import type { TextareaHTMLAttributes } from "react";
import { cn } from "./utils.js";

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea data-slot="textarea" className={cn("ui-textarea", className)} {...props} />;
}
