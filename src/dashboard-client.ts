export const MOBILE_DASHBOARD_PARAM = "livetree-mobile-client";
export const MOBILE_DASHBOARD_RETURN_PARAM = "livetree-return";
export const BUNDLED_SETTINGS_PARAM = "livetree-settings";
export const BUNDLED_DESKTOP_URL_PARAM = "livetree-desktop-url";
export const RECENT_DESKTOP_URL_PARAM = "livetree-recent-desktop";
export const MOBILE_DASHBOARD_PROTOCOL_VERSION = 1;

export type DashboardHealth = {
  ok?: unknown;
  service?: unknown;
  dashboard?: {
    version?: unknown;
    mobileClient?: unknown;
    protocolVersion?: unknown;
  };
};

export function supportsMobileDashboard(value: unknown): value is DashboardHealth {
  if (!value || typeof value !== "object") return false;
  const health = value as DashboardHealth;
  return health.ok === true
    && health.service === "livetree"
    && typeof health.dashboard?.version === "string"
    && health.dashboard.version.length > 0
    && health.dashboard.version !== "unavailable"
    && health.dashboard.mobileClient === true
    && health.dashboard.protocolVersion === MOBILE_DASHBOARD_PROTOCOL_VERSION;
}

export function mobileDashboardUrl(serverUrl: string, bundledUrl: string): URL {
  const url = new URL(serverUrl);
  url.searchParams.set(MOBILE_DASHBOARD_PARAM, "1");
  url.searchParams.set(MOBILE_DASHBOARD_RETURN_PARAM, bundledSettingsUrl(bundledUrl).toString());
  for (const recentUrl of recentDesktopUrls(bundledUrl)) url.searchParams.append(RECENT_DESKTOP_URL_PARAM, recentUrl);
  return url;
}

export function bundledSettingsUrl(value: string): URL {
  const url = new URL(value);
  url.searchParams.set(BUNDLED_SETTINGS_PARAM, "1");
  url.searchParams.delete(BUNDLED_DESKTOP_URL_PARAM);
  url.hash = "";
  return url;
}

export function bundledDesktopChangeUrl(value: string, desktopUrl: string, recentUrls: readonly string[]): URL {
  const url = bundledSettingsUrl(value);
  url.searchParams.set(BUNDLED_DESKTOP_URL_PARAM, desktopUrl);
  url.searchParams.delete(RECENT_DESKTOP_URL_PARAM);
  for (const recentUrl of recentUrls) url.searchParams.append(RECENT_DESKTOP_URL_PARAM, recentUrl);
  return url;
}

export function requestsBundledSettings(value: string): boolean {
  return new URL(value).searchParams.get(BUNDLED_SETTINGS_PARAM) === "1";
}

export function requestedBundledDesktopUrl(value: string): string | null {
  const url = new URL(value);
  if (url.searchParams.get(BUNDLED_SETTINGS_PARAM) !== "1") return null;
  return url.searchParams.get(BUNDLED_DESKTOP_URL_PARAM);
}

export function recentDesktopUrls(value: string): string[] {
  return new URL(value).searchParams.getAll(RECENT_DESKTOP_URL_PARAM);
}

export function mobileDashboardReturnUrl(value: string): URL | null {
  const url = new URL(value);
  if (url.searchParams.get(MOBILE_DASHBOARD_PARAM) !== "1") return null;
  const returnValue = url.searchParams.get(MOBILE_DASHBOARD_RETURN_PARAM);
  if (!returnValue) return null;

  try {
    const returnUrl = new URL(returnValue);
    const isTauri = returnUrl.protocol === "tauri:" && returnUrl.hostname === "localhost";
    const isTauriLocalhost = ["http:", "https:"].includes(returnUrl.protocol) && returnUrl.hostname === "tauri.localhost";
    const isLocalDevelopment = ["http:", "https:"].includes(returnUrl.protocol)
      && ["localhost", "127.0.0.1", "::1"].includes(returnUrl.hostname);
    return isTauri || isTauriLocalhost || isLocalDevelopment ? returnUrl : null;
  } catch {
    return null;
  }
}
