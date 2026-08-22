import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintDevEnv, resolveDevEnv, startDevProcess } from "../../../dist/commands/dev.js";
import { writeServerEntry } from "../../../dist/registry.js";
import { makeChoice, makeContext, tempDir } from "../../tests/helpers.mjs";

test("fingerprints resolved env without retaining secrets", () => {
  const left = fingerprintDevEnv({ TOKEN: "secret", URL: "local" });
  const right = fingerprintDevEnv({ URL: "local", TOKEN: "secret" });
  assert.equal(left, right);
  assert.doesNotMatch(left, /secret/);
  assert.deepEqual(resolveDevEnv({ API: "${url:api}" }, { urlForScript: () => "https://api.localhost", tunnelUrlForScript: () => "" }), { API: "https://api.localhost" });
});

test("refuses a duplicate server before spawning portless", async (t) => {
  const root = tempDir("dev-duplicate", t);
  const context = makeContext(root);
  const worktree = makeChoice({ path: root, branch: "main" });
  const config = {
    configPath: `${root}/.ltconf`, name: "app", initScript: null, copyFiles: [], links: {},
    devScripts: { web: { name: "web", cmd: "node server.js", env: {}, tunnelEnv: {}, portArg: null } },
  };
  writeServerEntry(context.stateDir, {
    name: "app-main-web", script: "web", worktree: root, pid: process.pid, url: "https://app-main-web.localhost",
    envFingerprint: fingerprintDevEnv({}), tunneled: false, startedAtMs: Date.now(), managed: false, logPath: null,
  });
  await assert.rejects(startDevProcess(context, config, worktree, "web", { proxy: { port: 443, tls: true }, managed: false }), /already running/);
});
