import assert from "node:assert/strict";
import test from "node:test";
import {
  BUNDLED_SETTINGS_PARAM,
  MOBILE_DASHBOARD_PARAM,
  mobileDashboardReturnUrl,
  mobileDashboardUrl,
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
