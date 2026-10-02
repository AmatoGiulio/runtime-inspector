import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "runtime-inspector.workbench.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === "system") return systemPrefersDark ? "dark" : "light";
  return choice;
}

/** system -> light -> dark -> system */
export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  switch (choice) {
    case "system":
      return "light";
    case "light":
      return "dark";
    default:
      return "system";
  }
}

/** Anything that is not a known choice falls back to "system". */
export function parseThemeChoice(value: unknown): ThemeChoice {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function themeChoiceLabel(choice: ThemeChoice): string {
  switch (choice) {
    case "light":
      return "Light";
    case "dark":
      return "Dark";
    default:
      return "Auto";
  }
}

function readStoredChoice(): ThemeChoice {
  try {
    return parseThemeChoice(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function writeStoredChoice(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage may be unavailable (private mode, blocked site data); the choice just is not persisted.
  }
}

function readSystemPrefersDark(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export function useWorkbenchTheme(): {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  cycle(): void;
} {
  const [choice, setChoice] = useState<ThemeChoice>(readStoredChoice);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(readSystemPrefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    setSystemPrefersDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved = resolveTheme(choice, systemPrefersDark);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const cycle = useCallback(() => {
    const next = nextThemeChoice(choice);
    writeStoredChoice(next);
    setChoice(next);
  }, [choice]);

  return { choice, resolved, cycle };
}
