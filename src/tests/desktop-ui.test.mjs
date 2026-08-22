import assert from "node:assert/strict";
import test from "node:test";
import { connectionStatus, createPaneBackSwipeRecognizer } from "../../dist/desktop-ui.js";

test("labels each desktop server mode without inferring it from the URL", () => {
  assert.equal(connectionStatus({ platform: "macos", serverMode: "background", dashboardReady: true, dashboardError: false }).label, "Background server");
  assert.equal(connectionStatus({ platform: "macos", serverMode: "bundled", dashboardReady: true, dashboardError: false }).label, "Bundled server");
  assert.equal(connectionStatus({ platform: "macos", serverMode: "starting", dashboardReady: false, dashboardError: false }).tone, "pending");
  assert.equal(connectionStatus({ platform: "macos", serverMode: "error", dashboardReady: false, dashboardError: false }).tone, "error");
});

test("reports remote mobile dashboards as Tailscale connections", () => {
  assert.deepEqual(
    connectionStatus({ platform: "ios", serverMode: "disconnected", dashboardReady: true, dashboardError: false }),
    { label: "Tailscale server", title: "Connected to a LiveTree server over Tailscale", tone: "active" },
  );
  assert.equal(connectionStatus({ platform: "ios", serverMode: "disconnected", dashboardReady: false, dashboardError: false }).label, "No server");
});

test("recognizes one deliberate trackpad back swipe per gesture", () => {
  const swipe = createPaneBackSwipeRecognizer({ threshold: 60 });
  assert.equal(swipe.update({ deltaX: -18, deltaY: 2, deltaMode: 0, timeStamp: 0 }), false);
  assert.equal(swipe.update({ deltaX: -24, deltaY: 3, deltaMode: 0, timeStamp: 16 }), false);
  assert.equal(swipe.update({ deltaX: -20, deltaY: 2, deltaMode: 0, timeStamp: 32 }), true);
  assert.equal(swipe.update({ deltaX: -30, deltaY: 1, deltaMode: 0, timeStamp: 48 }), false);
  assert.equal(swipe.update({ deltaX: -65, deltaY: 1, deltaMode: 0, timeStamp: 300 }), true);
});

test("rejects vertical, forward, and mouse-wheel gestures", () => {
  const swipe = createPaneBackSwipeRecognizer({ threshold: 40 });
  assert.equal(swipe.update({ deltaX: -50, deltaY: 60, deltaMode: 0, timeStamp: 0 }), false);
  assert.equal(swipe.update({ deltaX: 50, deltaY: 0, deltaMode: 0, timeStamp: 20 }), false);
  assert.equal(swipe.update({ deltaX: -50, deltaY: 0, deltaMode: 1, timeStamp: 40 }), false);
});
