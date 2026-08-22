import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { ITheme } from "@xterm/xterm";

export type Appearance = "dark" | "light";

// Terminal palettes mirror the CSS tokens in styles.css: `background` matches
// --inset and the ANSI colors keep >= 3:1 contrast against it in both themes
// (enforced by dashboard/tests/theme.test.mjs, which parses these literals —
// keep them as plain object literals).
export const terminalThemes: Record<Appearance, ITheme> = {
  dark: {
    background: "#0a0d11",
    foreground: "#d7ddd9",
    cursor: "#f1f3f2",
    selectionBackground: "#4a4f4c",
    black: "#1d2228",
    green: "#d7ddd9",
    brightGreen: "#ffffff",
    blue: "#75a7f8",
    brightBlue: "#a8c8ff",
    yellow: "#e6c86e",
    red: "#ef7d79",
  },
  light: {
    background: "#eef1ee",
    foreground: "#252a27",
    cursor: "#1d231f",
    selectionBackground: "#c4ccc6",
    black: "#454c46",
    green: "#1e7e46",
    brightGreen: "#0f5c33",
    blue: "#2c5cb0",
    brightBlue: "#1c4a99",
    yellow: "#8a6614",
    red: "#b03a32",
  },
};

export function terminalTheme(appearance: Appearance): ITheme {
  return terminalThemes[appearance];
}

/**
 * Reactive system appearance. Tracks the OS/browser light-vs-dark preference
 * and updates live when it changes. Must be called within a Solid owner scope
 * (component setup) so the media-query listener is cleaned up.
 */
export function useSystemAppearance(): Accessor<Appearance> {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => "dark";
  }
  const query = window.matchMedia("(prefers-color-scheme: light)");
  const [appearance, setAppearance] = createSignal<Appearance>(query.matches ? "light" : "dark");
  const update = () => setAppearance(query.matches ? "light" : "dark");
  query.addEventListener("change", update);
  onCleanup(() => query.removeEventListener("change", update));
  return appearance;
}
