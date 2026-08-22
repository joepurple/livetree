import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readServerEntries, removeServerEntry, writeServerEntry } from "../../dist/registry.js";
import { tempDir } from "./helpers.mjs";

test("writes private atomic entries and removes stale processes", (t) => {
  const state = tempDir("registry", t);
  const alive = { name: "app-main-web", script: "web", worktree: "/repo", pid: process.pid, url: "https://app.localhost", envFingerprint: "secret-free", tunneled: false, startedAtMs: 1, managed: false, logPath: null };
  writeServerEntry(state, alive);
  const file = path.join(state, "servers", `${alive.name}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(file, "utf8"), /API_KEY/);
  assert.deepEqual(readServerEntries(state), [alive]);
  mkdirSync(path.join(state, "servers"), { recursive: true });
  writeFileSync(path.join(state, "servers", "stale.json"), JSON.stringify({ ...alive, name: "stale", pid: 99999999 }));
  assert.deepEqual(readServerEntries(state), [alive]);
  removeServerEntry(state, alive.name);
  assert.deepEqual(readServerEntries(state), []);
});
