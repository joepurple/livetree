import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));

test("remote iOS dashboards can only invoke the validated external URL opener", () => {
  const capability = readJson("src-tauri/capabilities/mobile-dashboard.json");
  assert.equal(capability.local, false);
  assert.deepEqual(capability.platforms, ["iOS"]);
  assert.deepEqual(capability.permissions, ["allow-open-external-url"]);
  assert.deepEqual(capability.remote.urls, ["https://*.ts.net", "https://*.ts.net:*"]);
});

test("local app capabilities retain every registered custom command", () => {
  const capability = readJson("src-tauri/capabilities/default.json");
  for (const permission of [
    "allow-native-info",
    "allow-read-desktop-url",
    "allow-write-desktop-url",
    "allow-clear-desktop-url",
    "allow-open-external-url",
    "allow-open-worktree-folder",
  ]) {
    assert.ok(capability.permissions.includes(permission), `missing ${permission}`);
  }
});
