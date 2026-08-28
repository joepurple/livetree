import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { BUNDLED_DESKTOP_URL_PARAM, BUNDLED_SETTINGS_PARAM, mobileDashboardReturnUrl, mobileDashboardUrl, recentDesktopUrls, requestedBundledDesktopUrl, requestsBundledSettings, supportsMobileDashboard } from "../../src/dashboard-client";
import type { ServerMode } from "../../src/desktop-ui.js";
import { normalizeDesktopUrl } from "../../src/mobile-link";

export { normalizeDesktopUrl };

export type NativeInfo = {
  platform: "macos" | "ios";
  serverMode: ServerMode;
  serverUrl: string | null;
  tailnetUrl: string | null;
  error: string | null;
  menuBarMode: boolean;
};

let apiBase: string | undefined;

export function runningInTauri(): boolean {
  if (!isTauri()) return false;
  if (import.meta.env.DEV) return true;
  return window.location.protocol === "tauri:" || window.location.hostname === "tauri.localhost";
}

export function nativeLinkOpenerAvailable(): boolean {
  return isTauri();
}

export function connectedDashboardReturnUrl(): URL | null {
  return mobileDashboardReturnUrl(window.location.href);
}

export function bundledSettingsRequested(): boolean {
  return requestsBundledSettings(window.location.href);
}

export function bundledDesktopUrlRequested(): string | null {
  return requestedBundledDesktopUrl(window.location.href);
}

export function bundledRecentDesktopUrls(): string[] {
  return recentDesktopUrls(window.location.href);
}

export function clearBundledSettingsRequest(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(BUNDLED_SETTINGS_PARAM);
  url.searchParams.delete(BUNDLED_DESKTOP_URL_PARAM);
  window.history.replaceState(window.history.state, "", url);
}

export async function loadServerDashboard(value: string): Promise<boolean> {
  const normalized = normalizeDesktopUrl(value);
  if (!await desktopDashboardAvailable(normalized)) return false;
  window.location.replace(mobileDashboardUrl(normalized, window.location.href));
  return true;
}

export async function desktopDashboardAvailable(value: string): Promise<boolean> {
  const normalized = normalizeDesktopUrl(value);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(new URL("api/health", `${normalized}/`), { cache: "no-store", signal: controller.signal });
    return response.ok && supportsMobileDashboard(await response.json());
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function readNativeInfo(): Promise<NativeInfo> {
  return invoke<NativeInfo>("native_info");
}

export async function setMenuBarMode(enabled: boolean): Promise<NativeInfo> {
  return invoke<NativeInfo>("set_menu_bar_mode", { enabled });
}

export async function pickProjectFolder(): Promise<string | null> {
  const selected = await open({
    title: "Add LiveTree Project",
    directory: true,
    multiple: false,
    canCreateDirectories: false,
  });
  return typeof selected === "string" ? selected : null;
}

export async function openExternalUrl(value: string): Promise<void> {
  await invoke("open_external_url", { url: value });
}

export async function openWorktreeFolder(value: string): Promise<void> {
  await invoke("open_worktree_folder", { path: value });
}

export async function readPersistedDesktopUrl(): Promise<string | null> {
  return invoke<string | null>("read_desktop_url");
}

export async function persistDesktopUrl(value: string): Promise<void> {
  await invoke("write_desktop_url", { url: value });
}

export async function clearPersistedDesktopUrl(): Promise<void> {
  await invoke("clear_desktop_url");
}

export function setApiBase(value: string | undefined): void {
  apiBase = value ? value.replace(/\/+$/, "") : undefined;
}

export function apiUrl(route: string): URL {
  return new URL(`api/${route}`, apiBase ? `${apiBase}/` : document.baseURI);
}
