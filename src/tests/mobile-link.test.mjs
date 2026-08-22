import assert from "node:assert/strict";
import test from "node:test";
import { desktopUrlFromMobileAppLink, normalizeDesktopUrl } from "../../dist/mobile-link.js";

test("extracts and normalizes a Tailnet dashboard URL from a mobile app link", () => {
  assert.equal(
    desktopUrlFromMobileAppLink("livetree://connect?url=https%3A%2F%2Fdevbox.tail123.ts.net%3A8443%2F%3Fignored%3Dyes"),
    "https://devbox.tail123.ts.net:8443",
  );
});

test("ignores links not intended to connect the LiveTree mobile app", () => {
  assert.equal(desktopUrlFromMobileAppLink("https://devbox.tail123.ts.net"), null);
  assert.equal(desktopUrlFromMobileAppLink("livetree://settings"), null);
  assert.equal(desktopUrlFromMobileAppLink("not a URL"), null);
});

test("rejects app links without a safe remote dashboard URL", () => {
  assert.throws(
    () => desktopUrlFromMobileAppLink("livetree://connect"),
    /does not include a Tailnet dashboard URL/,
  );
  assert.throws(
    () => desktopUrlFromMobileAppLink("livetree://connect?url=http%3A%2F%2Fremote.example.com"),
    /HTTPS Tailnet dashboard URL/,
  );
});

test("allows loopback HTTP URLs for local development", () => {
  assert.equal(normalizeDesktopUrl("http://127.0.0.1:43117/"), "http://127.0.0.1:43117");
  assert.equal(normalizeDesktopUrl("http://localhost:43117/path/"), "http://localhost:43117/path");
});
