import {
  type ResolvedTheme,
  THEME_OPTIONS,
  type Theme,
  applyThemeToDocument,
  getStoredTheme,
  getSystemTheme,
  setStoredTheme,
} from "@omp-remote/ui";
import {
  type CSSProperties,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { DashboardIcon } from "../dashboard/icon.js";
import { Button } from "./button.js";
import { cn } from "./utils.js";

export interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme(theme: Theme): void;
  toggleTheme(): void;
}

const DEFAULT_THEME_CONTEXT: ThemeContextValue = {
  theme: "system",
  resolvedTheme: "dark",
  setTheme: () => undefined,
  toggleTheme: () => undefined,
};

export const ThemeContext = createContext<ThemeContextValue>(DEFAULT_THEME_CONTEXT);

const THEME_SELECTOR_STYLE: CSSProperties = {
  margin: 0,
  minWidth: 0,
};

export interface ThemeProviderProps {
  children: ReactNode;
  defaultTheme?: Theme;
}

export function ThemeProvider({ children, defaultTheme }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    return defaultTheme ?? getStoredTheme();
  });

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };

    setSystemTheme(mediaQuery.matches ? "dark" : "light");

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }
  }, []);

  useEffect(() => {
    applyThemeToDocument(theme, resolvedTheme);
  }, [theme, resolvedTheme]);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    setStoredTheme(newTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const nextTheme: Theme = current === "system" ? "light" : current === "light" ? "dark" : "system";
      setStoredTheme(nextTheme);
      return nextTheme;
    });
  }, []);

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
      toggleTheme,
    }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, resolvedTheme, toggleTheme } = useTheme();
  const nextThemeLabel = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const currentThemeLabel =
    theme === "system" ? `System (${resolvedTheme})` : theme === "light" ? "Light" : "Dark";

  return (
    <Button
      className={cn("theme-toggle-button", className)}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Theme: ${currentThemeLabel}. Click to switch to ${nextThemeLabel} mode.`}
      title={`Theme: ${currentThemeLabel} (click for ${nextThemeLabel})`}
      data-theme-mode={theme}
      onClick={toggleTheme}
    >
      <DashboardIcon name={theme === "system" ? "laptop" : theme === "light" ? "sun" : "moon"} />
    </Button>
  );
}

export interface ThemeSelectorProps {
  className?: string;
}

export function ThemeSelector({ className }: ThemeSelectorProps) {
  const { theme, setTheme } = useTheme();

  return (
    <fieldset className={cn("ui-theme-selector", className)} style={THEME_SELECTOR_STYLE}>
      <legend className="sr-only">Theme mode selection</legend>
      {THEME_OPTIONS.map((option) => {
        const selected = theme === option.value;
        const iconName = option.value === "system" ? "laptop" : option.value === "light" ? "sun" : "moon";
        return (
          <Button
            key={option.value}
            type="button"
            variant={selected ? "default" : "ghost"}
            size="sm"
            className={cn("ui-theme-option", selected && "ui-theme-option-selected")}
            aria-pressed={selected}
            aria-label={`${option.label} theme`}
            title={option.description}
            onClick={() => setTheme(option.value)}
          >
            <DashboardIcon name={iconName} />
            <span>{option.label}</span>
          </Button>
        );
      })}
    </fieldset>
  );
}
