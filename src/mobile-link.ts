const MOBILE_APP_PROTOCOL = "livetree:";
const MOBILE_APP_CONNECTION_HOST = "connect";

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

export function desktopUrlFromMobileAppLink(value: string): string | null {
  let link: URL;
  try {
    link = new URL(value);
  } catch {
    return null;
  }

  if (link.protocol !== MOBILE_APP_PROTOCOL || link.hostname !== MOBILE_APP_CONNECTION_HOST) {
    return null;
  }

  const desktopUrl = link.searchParams.get("url");
  if (!desktopUrl) {
    throw new Error("The LiveTree app link does not include a Tailnet dashboard URL.");
  }
  return normalizeDesktopUrl(desktopUrl);
}
