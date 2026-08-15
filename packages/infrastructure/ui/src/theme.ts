export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "omp-theme";

export interface ThemeOption {
  value: Theme;
  label: string;
  description: string;
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: "system", label: "System", description: "Match device light or dark mode" },
  { value: "light", label: "Light", description: "Light background with high-contrast text" },
  { value: "dark", label: "Dark", description: "Dark background with vibrant accents" },
];

export function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getStoredTheme(): Theme {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return "system";
  }
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) {
      return stored;
    }
  } catch {
    // Ignore localStorage errors
  }
  return "system";
}

export function setStoredTheme(theme: Theme): void {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore localStorage errors
  }
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return getSystemTheme();
  }
  return theme;
}

export function applyThemeToDocument(theme: Theme, resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-theme-setting", theme);
  root.style.colorScheme = resolved;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);

  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute("content", resolved === "light" ? "#fbfbfc" : "#0d0c13");
  }
}
