import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type NativeInfo = {
  platform: "macos" | "ios";
  serverUrl: string | null;
  tailnetUrl: string | null;
  error: string | null;
};

let apiBase: string | undefined;

export function runningInTauri(): boolean {
  return isTauri();
}

export async function readNativeInfo(): Promise<NativeInfo> {
  return invoke<NativeInfo>("native_info");
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

export function setApiBase(value: string | undefined): void {
  apiBase = value ? value.replace(/\/+$/, "") : undefined;
}

export function apiUrl(route: string): URL {
  return new URL(`api/${route}`, apiBase ? `${apiBase}/` : document.baseURI);
}

export function normalizeDesktopUrl(value: string): string {
  const url = new URL(value.trim());
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Use the HTTPS Tailnet dashboard URL shown in the Mac app.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
