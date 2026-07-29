import type { ButtonHTMLAttributes } from "react";
import { cn } from "./utils.js";

export type ButtonVariant = "default" | "outline" | "ghost" | "destructive";
export type ButtonSize = "default" | "sm" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ className, variant = "default", size = "default", ...props }: ButtonProps) {
  return (
    <button
      data-slot="button"
      className={cn("ui-button", `ui-button-${variant}`, `ui-button-size-${size}`, className)}
      {...props}
    />
  );
}
