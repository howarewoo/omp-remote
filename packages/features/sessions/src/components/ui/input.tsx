import type { InputHTMLAttributes } from "react";
import { cn } from "./utils.js";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input data-slot="input" className={cn("ui-input", className)} {...props} />;
}
