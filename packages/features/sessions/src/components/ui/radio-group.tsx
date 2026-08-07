import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "./utils.js";

export function RadioGroup<Value>({ className, ...props }: RadioGroupPrimitive.Props<Value>) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={(state) =>
        cn("ui-radio-group", typeof className === "function" ? className(state) : className)
      }
      {...props}
    />
  );
}

export function RadioGroupItem<Value>({ className, ...props }: RadioPrimitive.Root.Props<Value>) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={(state) =>
        cn("ui-radio-group-item", typeof className === "function" ? className(state) : className)
      }
      {...props}
    />
  );
}
