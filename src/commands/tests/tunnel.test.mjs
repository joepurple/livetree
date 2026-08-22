import assert from "node:assert/strict";
import test from "node:test";
import { ensureTunnelForScript } from "../../../dist/commands/tunnel.js";
import { fingerprintDevEnv } from "../../../dist/commands/dev.js";
import { isTunnelEnvPending, writeServerEntry, writeTunnelEntry } from "../../../dist/registry.js";
import { makeChoice, makeContext, tempDir } from "../../tests/helpers.mjs";

function fixture(root) {
  return {
    context: makeContext(root),
    worktree: makeChoice({ path: root, branch: "main" }),
    config: {
      configPath: `${root}/.ltconf`, name: "app", initScript: null, copyFiles: [], links: {},
      devScripts: {
        api: { name: "api", cmd: "node api.js", env: {}, tunnelEnv: {}, portArg: null },
        web: { name: "web", cmd: "node web.js", env: { API: "${url:api}" }, tunnelEnv: { API: "${tunnelUrl:api}" }, portArg: null },
      },
    },
  };
}

const options = {
  tailscale: { binPath: "/unused", dnsName: "devbox.tail.ts.net", baseUrl: "https://devbox.tail.ts.net" },
  proxy: { port: 443, tls: true }, detached: false, created: [], log: () => {},
};

test("requires a registered local server before opening a tunnel", async (t) => {
  const root = tempDir("tunnel-missing", t);
  const { context, config, worktree } = fixture(root);
  await assert.rejects(ensureTunnelForScript(context, config, worktree, "api", { ...options, created: [] }), /Start it first: livetree dev api/);
});

test("refuses to expose a foreground server with stale tunnel env", async (t) => {
  const root = tempDir("tunnel-env", t);
  const { context, config, worktree } = fixture(root);
  writeServerEntry(context.stateDir, {
    name: "app-main-web", script: "web", worktree: root, pid: process.pid, url: "https://app-main-web.localhost",
    envFingerprint: fingerprintDevEnv({ API: "https://app-main-api.localhost" }), tunneled: false,
    startedAtMs: Date.now(), managed: false, logPath: null,
  });
  writeServerEntry(context.stateDir, {
    name: "app-main-api", script: "api", worktree: root, pid: process.pid, url: "https://app-main-api.localhost",
    envFingerprint: fingerprintDevEnv({}), tunneled: false, startedAtMs: Date.now(), managed: false, logPath: null,
  });
  writeTunnelEntry(context.stateDir, {
    name: "app-main-api", script: "api", worktree: root, pid: process.pid,
    url: "https://devbox.tail.ts.net", httpsPort: 443, startedAtMs: Date.now(),
  });
  await assert.rejects(
    ensureTunnelForScript(context, config, worktree, "web", { ...options, created: [] }),
    /Restart it yourself:.*livetree dev web/s,
  );
  assert.equal(isTunnelEnvPending(context.stateDir, "app-main-web"), true);
});
