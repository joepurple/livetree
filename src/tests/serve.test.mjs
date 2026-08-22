import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { reconcileManagedProcesses } from "../../dist/commands/serve.js";
import { registerProject } from "../../dist/projects.js";
import { readServerEntries, readTunnelEntries, writeServerEntry, writeTunnelEntry } from "../../dist/registry.js";
import { cliPath, createGitRepo, tempDir, withEnv } from "./helpers.mjs";

test("serves dashboard HTML and JSON on loopback", async (t) => {
  const repo = createGitRepo(t, "serve");
  const secondRepo = createGitRepo(t, "serve-second");
  const livetreeHome = tempDir("serve-home", t);
  writeFileSync(path.join(repo, ".ltconf"), `name: demo\ndev:\n  web: node server.mjs\nlinks:\n  web: \${url:web}\n`);
  writeFileSync(path.join(secondRepo, ".ltconf"), `name: second\ndev:\n  api: node api.mjs\n`);
  await withEnv({ LIVETREE_HOME: livetreeHome }, async () => registerProject(secondRepo, 1));
  const stateDir = path.join(repo, ".livetree", "state");
  const logPath = path.join(stateDir, "logs", "demo-main-web.log");
  mkdirSync(path.dirname(logPath), { recursive: true });
  mkdirSync(path.join(stateDir, "servers"), { recursive: true });
  writeFileSync(logPath, "ready on port 4173\n");
  writeFileSync(path.join(stateDir, "servers", "demo-main-web.json"), JSON.stringify({
    name: "demo-main-web", script: "web", worktree: repo, pid: process.pid,
    url: "https://demo-main-web.localhost:1355", envFingerprint: "test", tunneled: false,
    startedAtMs: Date.now(), managed: true, logPath,
  }));
  const secondStateDir = path.join(secondRepo, ".livetree", "state");
  const secondLogPath = path.join(secondStateDir, "logs", "second-main-api.log");
  mkdirSync(path.dirname(secondLogPath), { recursive: true });
  mkdirSync(path.join(secondStateDir, "servers"), { recursive: true });
  writeFileSync(secondLogPath, "second project api ready\n");
  writeFileSync(path.join(secondStateDir, "servers", "second-main-api.json"), JSON.stringify({
    name: "second-main-api", script: "api", worktree: secondRepo, pid: process.pid,
    url: "https://second-main-api.localhost:1355", envFingerprint: "test", tunneled: false,
    startedAtMs: Date.now(), managed: true, logPath: secondLogPath,
  }));
  const child = spawn(process.execPath, [cliPath, "serve", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, LIVETREE_HOME: livetreeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const output = await waitForOutput(child.stdout, /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/);
  const url = /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output)[1];
  const html = await fetch(url);
  assert.equal(html.status, 200);
  const source = await html.text();
  assert.match(source, /<title>livetree<\/title>/);
  const assetPath = /<script type="module" crossorigin src="([^"]+)"/.exec(source)?.[1];
  assert.ok(assetPath);
  const asset = await fetch(new URL(assetPath, url));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
  const state = await fetch(`${url}api/state`);
  assert.equal(state.status, 200);
  const json = await state.json();
  assert.deepEqual(json.projects.map((project) => project.name), ["demo", "second"]);
  assert.equal(json.projects[0].id, repo);
  assert.equal(json.projects[0].worktrees[0].scripts[0].script, "web");
  assert.equal(json.projects[0].worktrees[0].links[0].url, "https://demo-main-web.localhost:1355");
  assert.equal(json.projects[0].worktrees[0].chat, null);
  assert.equal("chats" in json.projects[0].worktrees[0], false);
  assert.equal(json.projects[0].worktrees[0].scripts[0].logPath, logPath);
  assert.equal(json.projects[1].id, secondRepo);
  assert.equal(json.projects[1].worktrees[0].scripts[0].script, "api");
  assert.equal(json.projects[1].worktrees[0].scripts[0].running, true);

  const controller = new AbortController();
  const logs = await fetch(`${url}api/logs?project=${encodeURIComponent(repo)}&worktree=${encodeURIComponent(repo)}&script=web`, { signal: controller.signal });
  assert.equal(logs.status, 200);
  const chunk = await logs.body.getReader().read();
  controller.abort();
  assert.match(new TextDecoder().decode(chunk.value), /ready on port 4173/);

  const secondController = new AbortController();
  const secondLogs = await fetch(`${url}api/logs?project=${encodeURIComponent(secondRepo)}&worktree=${encodeURIComponent(secondRepo)}&script=api`, { signal: secondController.signal });
  assert.equal(secondLogs.status, 200);
  const secondChunk = await secondLogs.body.getReader().read();
  secondController.abort();
  assert.match(new TextDecoder().decode(secondChunk.value), /second project api ready/);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));

  const restarted = spawn(process.execPath, [cliPath, "serve", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, LIVETREE_HOME: livetreeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (restarted.exitCode === null) restarted.kill("SIGTERM"); });
  const restartedOutput = await waitForOutput(restarted.stdout, /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/);
  const restartedUrl = /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(restartedOutput)[1];
  const recoveredState = await fetch(`${restartedUrl}api/state`);
  assert.equal(recoveredState.status, 200);
  const recoveredJson = await recoveredState.json();
  assert.equal(recoveredJson.projects[0].worktrees[0].scripts[0].running, true);
  assert.equal(recoveredJson.projects[0].worktrees[0].scripts[0].pid, process.pid);
});

test("reconciles managed processes without losing valid dashboard state", async (t) => {
  const repo = createGitRepo(t, "serve-reconcile");
  const stateDir = path.join(repo, ".livetree", "state");
  const context = {
    stateDir,
    choices: [{ path: repo, branch: "main", head: null, bare: false, prunable: null, label: "main", ref: "main", chat: null, chats: [], isMain: true }],
  };
  const config = {
    name: "demo",
    devScripts: { web: { name: "web", cmd: "node web.mjs", env: {}, tunnelEnv: {}, portArg: null, tunnelPort: "auto" } },
  };
  const entry = (name, script, managed) => ({
    name, script, worktree: repo, pid: process.pid, url: `https://${name}.localhost`, envFingerprint: "test",
    tunneled: false, startedAtMs: Date.now(), managed, logPath: null,
  });
  writeServerEntry(stateDir, entry("demo-main-web", "web", true));
  writeServerEntry(stateDir, entry("demo-main-old", "old", true));
  writeServerEntry(stateDir, entry("demo-main-manual", "manual", false));
  writeTunnelEntry(stateDir, {
    name: "demo-main-old", script: "old", worktree: repo, pid: process.pid,
    url: "https://devbox.ts.net:8443", httpsPort: 8443, startedAtMs: Date.now(),
  });
  const stopped = [];

  await reconcileManagedProcesses(context, config, { stop: async (pid) => { stopped.push(pid); }, log: () => {} });

  assert.deepEqual(stopped, [process.pid, process.pid]);
  assert.deepEqual(readServerEntries(stateDir).map(({ name }) => name), ["demo-main-manual", "demo-main-web"]);
  assert.deepEqual(readTunnelEntries(stateDir), []);
});

function waitForOutput(stream, pattern) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}: ${output}`)), 5000);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      if (pattern.test(output)) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
  });
}
