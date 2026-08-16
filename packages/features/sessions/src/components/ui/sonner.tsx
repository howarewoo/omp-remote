import { useTheme } from "./theme-provider.js";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function resolveAppTheme(theme: string | undefined): NonNullable<ToasterProps["theme"]> {
  if (theme === "light" || theme === "dark" || theme === "system") {
    return theme;
  }
  return "system";
}

const Toaster = ({ theme: themeProp, ...props }: ToasterProps) => {
  const { theme: appTheme } = useTheme();
  const theme: NonNullable<ToasterProps["theme"]> = themeProp ?? resolveAppTheme(appTheme);

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, type ToasterProps };
