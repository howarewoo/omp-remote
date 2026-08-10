import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "./utils.js";

export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={(state) => cn("ui-switch", typeof className === "function" ? className(state) : className)}
      {...props}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className="ui-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
