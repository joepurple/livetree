import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_STARTUP_GRACE_MS,
  serverLifecycleStatus,
  worktreeServerStatus,
  worktreeServerStatusLabel,
} from "../../dist/server-status.js";

const now = 100_000;
const stopped = { running: false, healthy: false, startedAtMs: null };
const healthy = { running: true, healthy: true, startedAtMs: now - 60_000 };
const starting = { running: true, healthy: false, startedAtMs: now - 1_000 };
const failed = { running: true, healthy: false, startedAtMs: now - SERVER_STARTUP_GRACE_MS };

test("classifies an unhealthy server as failed after its startup grace period", () => {
  assert.equal(serverLifecycleStatus(stopped, now), "stopped");
  assert.equal(serverLifecycleStatus(healthy, now), "healthy");
  assert.equal(serverLifecycleStatus(starting, now), "starting");
  assert.equal(serverLifecycleStatus(failed, now), "failed");
});

test("prioritizes failed, then starting, then healthy worktree server states", () => {
  assert.equal(worktreeServerStatus([], now), "idle");
  assert.equal(worktreeServerStatus([stopped, stopped], now), "idle");
  assert.equal(worktreeServerStatus([stopped, healthy], now), "healthy");
  assert.equal(worktreeServerStatus([healthy, starting], now), "starting");
  assert.equal(worktreeServerStatus([starting, failed], now), "failed");
});

test("provides accessible labels for every worktree server state", () => {
  assert.equal(worktreeServerStatusLabel("idle"), "No servers running");
  assert.equal(worktreeServerStatusLabel("failed"), "One or more servers failed");
  assert.equal(worktreeServerStatusLabel("starting"), "One or more servers starting");
  assert.equal(worktreeServerStatusLabel("healthy"), "All running servers healthy");
});
