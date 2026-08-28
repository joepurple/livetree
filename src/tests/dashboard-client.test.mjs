import assert from "node:assert/strict";
import test from "node:test";
import {
  BUNDLED_DESKTOP_URL_PARAM,
  BUNDLED_SETTINGS_PARAM,
  MOBILE_DASHBOARD_PARAM,
  RECENT_DESKTOP_URL_PARAM,
  bundledDesktopChangeUrl,
  mobileDashboardReturnUrl,
  mobileDashboardUrl,
  recentDesktopUrls,
  requestedBundledDesktopUrl,
  requestsBundledSettings,
  supportsMobileDashboard,
} from "../../dist/dashboard-client.js";

test("recognizes servers that can host the mobile dashboard", () => {
  assert.equal(supportsMobileDashboard({
    ok: true,
    service: "livetree",
    dashboard: { version: "0123456789abcdef", mobileClient: true, protocolVersion: 1 },
  }), true);
  assert.equal(supportsMobileDashboard({ ok: true, service: "livetree" }), false);
  assert.equal(supportsMobileDashboard({
    ok: true,
    service: "livetree",
    dashboard: { version: "unavailable", mobileClient: true, protocolVersion: 1 },
  }), false);
  assert.equal(supportsMobileDashboard({
    ok: true,
    service: "livetree",
    dashboard: { version: "0123456789abcdef", mobileClient: true, protocolVersion: 2 },
  }), false);
});

test("builds a server dashboard URL with a safe bundled return target", () => {
  const url = mobileDashboardUrl(
    "https://devbox.example.ts.net",
    "tauri://localhost/index.html#workspace",
  );
  assert.equal(url.origin, "https://devbox.example.ts.net");
  assert.equal(url.searchParams.get(MOBILE_DASHBOARD_PARAM), "1");
  const returnUrl = mobileDashboardReturnUrl(url.toString());
  assert.equal(returnUrl?.protocol, "tauri:");
  assert.equal(returnUrl?.searchParams.get(BUNDLED_SETTINGS_PARAM), "1");
  assert.equal(requestsBundledSettings(returnUrl?.toString() ?? ""), true);
});

test("rejects non-bundled mobile dashboard return targets", () => {
  const url = new URL("https://devbox.example.ts.net");
  url.searchParams.set(MOBILE_DASHBOARD_PARAM, "1");
  url.searchParams.set("livetree-return", "https://evil.example/settings");
  assert.equal(mobileDashboardReturnUrl(url.toString()), null);
});

test("carries a requested desktop and recent links through the bundled handoff", () => {
  const bundled = bundledDesktopChangeUrl(
    "tauri://localhost/index.html",
    "https://second.example.ts.net",
    ["https://second.example.ts.net", "https://first.example.ts.net"],
  );
  assert.equal(bundled.searchParams.get(BUNDLED_DESKTOP_URL_PARAM), "https://second.example.ts.net");
  assert.equal(requestedBundledDesktopUrl(bundled.toString()), "https://second.example.ts.net");
  assert.deepEqual(recentDesktopUrls(bundled.toString()), ["https://second.example.ts.net", "https://first.example.ts.net"]);

  const remote = mobileDashboardUrl("https://second.example.ts.net", bundled.toString());
  assert.deepEqual(remote.searchParams.getAll(RECENT_DESKTOP_URL_PARAM), ["https://second.example.ts.net", "https://first.example.ts.net"]);
  assert.equal(mobileDashboardReturnUrl(remote.toString())?.searchParams.has(BUNDLED_DESKTOP_URL_PARAM), false);
});
