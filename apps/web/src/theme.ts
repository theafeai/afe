import { useCallback, useState } from "react";

/**
 * Theme choice (ADR 0015). "system" follows the OS setting through the
 * `prefers-color-scheme` block in styles.css; "light" and "dark" set
 * `data-theme` on <html>, which the token blocks in styles.css read. The choice
 * is a per-browser convenience kept in localStorage; storage may be unavailable
 * (private windows, blocked site data), in which case the OS setting applies.
 */
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "afe.theme";

export function readTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const choose = useCallback((choice: ThemeChoice) => {
    applyTheme(choice);
    setTheme(choice);
    try {
      if (choice === "system") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, choice);
    } catch {
      // Storage unavailable: the choice lasts for this page view only.
    }
  }, []);
  return [theme, choose];
}
