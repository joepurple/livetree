import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { reconcileManagedProcesses, resolveServeContext } from "../../dist/commands/serve.js";
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
  const child = spawn(process.execPath, [cliPath, "server", "start", "--foreground", "--no-tailscale", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, LIVETREE_HOME: livetreeHome, LIVETREE_TAILSCALE_BIN: path.join(livetreeHome, "missing-tailscale") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const output = await waitForOutput(child.stdout, /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/);
  const url = /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output)[1];
  const html = await fetch(url);
  assert.equal(html.status, 200);
  const source = await html.text();
  assert.match(source, /<title>livetree<\/title>/);
  assert.equal(html.headers.get("cache-control"), "no-store");
  const dashboardVersion = /<meta name="livetree-dashboard-version" content="([a-f0-9]{16})" \/>/.exec(source)?.[1];
  assert.ok(dashboardVersion);
  const assetPath = /<script type="module" crossorigin src="([^"]+)"/.exec(source)?.[1];
  assert.ok(assetPath);
  const asset = await fetch(new URL(assetPath, url));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.equal(asset.headers.get("cache-control"), "no-store");
  const state = await fetch(`${url}api/state`);
  assert.equal(state.status, 200);
  const json = await state.json();
  assert.equal(json.dashboardVersion, dashboardVersion);
  assert.deepEqual(json.tailnet, { status: "disabled", url: null, error: null });
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

  const retryTailnet = await fetch(`${url}api/tailnet/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(retryTailnet.status, 400);
  assert.match((await retryTailnet.json()).error, /not executable/);
  const unavailableTailnet = await (await fetch(`${url}api/state`)).json();
  assert.match(unavailableTailnet.tailnet.error, /not executable/);
  assert.equal(unavailableTailnet.tailnet.status, "unavailable");

  const addedRepo = createGitRepo(t, "serve-added");
  writeFileSync(path.join(addedRepo, ".ltconf"), "name: added\n");
  const addProject = await fetch(`${url}api/projects/add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: addedRepo }),
  });
  assert.equal(addProject.status, 200);
  assert.equal((await addProject.json()).project, addedRepo);
  const addedState = await (await fetch(`${url}api/state`)).json();
  assert.deepEqual(addedState.projects.map((project) => project.name), ["added", "demo", "second"]);

  const removeProject = await fetch(`${url}api/projects/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: addedRepo }),
  });
  assert.equal(removeProject.status, 200);
  const removedProjectState = await (await fetch(`${url}api/state`)).json();
  assert.deepEqual(removedProjectState.projects.map((project) => project.name), ["demo", "second"]);

  const linked = path.join(path.dirname(repo), "serve-linked");
  execFileSync("git", ["worktree", "add", "-b", "remove-me", linked], { cwd: repo, stdio: "ignore" });
  t.after(() => {
    try { execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: repo, stdio: "ignore" }); } catch {}
  });
  const removeMain = await fetch(`${url}api/worktrees/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: repo, worktree: repo }),
  });
  assert.equal(removeMain.status, 400);
  assert.match((await removeMain.json()).error, /main worktree cannot be removed/i);
  writeFileSync(path.join(linked, "uncommitted.txt"), "keep me\n");
  const refuseDirtyWorktree = await fetch(`${url}api/worktrees/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: repo, worktree: linked }),
  });
  assert.equal(refuseDirtyWorktree.status, 400);
  assert.equal(existsSync(linked), true);
  const removeWorktree = await fetch(`${url}api/worktrees/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: repo, worktree: linked, force: true }),
  });
  assert.equal(removeWorktree.status, 200);
  assert.equal(existsSync(linked), false);

  const preflight = await fetch(`${url}api/dev/start`, {
    method: "OPTIONS",
    headers: { origin: "tauri://localhost", "access-control-request-method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "tauri://localhost");
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);

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

  const outside = tempDir("serve-outside-git", t);
  const restarted = spawn(process.execPath, [cliPath, "server", "start", "--foreground", "--no-tailscale", "--port", "0"], {
    cwd: outside,
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

test("resolves serve from outside Git using the most recently used saved project", async (t) => {
  const outside = tempDir("serve-outside", t);
  const stale = tempDir("serve-stale", t);
  const olderRepo = createGitRepo(t, "serve-older");
  const newerRepo = createGitRepo(t, "serve-newer");
  const livetreeHome = tempDir("serve-resolve-home", t);
  writeFileSync(path.join(olderRepo, ".ltconf"), "name: older\n");
  writeFileSync(path.join(newerRepo, ".ltconf"), "name: newer\n");

  await withEnv({ LIVETREE_HOME: livetreeHome }, async () => {
    registerProject(olderRepo, 10);
    registerProject(newerRepo, 20);
    registerProject(stale, 30);

    const context = resolveServeContext(outside);
    assert.equal(context.mainRoot, newerRepo);
  });
});

test("serves from outside Git without any saved projects", async (t) => {
  const outside = tempDir("serve-empty-outside", t);
  const livetreeHome = tempDir("serve-empty-home", t);

  await withEnv({ LIVETREE_HOME: livetreeHome }, async () => {
    assert.equal(resolveServeContext(outside), null);
  });

  const child = spawn(process.execPath, [cliPath, "server", "start", "--foreground", "--no-tailscale", "--port", "0"], {
    cwd: outside,
    env: { ...process.env, LIVETREE_HOME: livetreeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const output = await waitForOutput(child.stdout, /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/);
  const url = /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output)[1];
  const state = await fetch(`${url}api/state`);
  assert.equal(state.status, 200);
  assert.deepEqual((await state.json()).projects, []);

  const repo = createGitRepo(t, "serve-empty-add");
  writeFileSync(path.join(repo, ".ltconf"), "name: first\n");
  const added = await fetch(`${url}api/projects/add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: repo }),
  });
  assert.equal(added.status, 200);
  const removed = await fetch(`${url}api/projects/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: repo }),
  });
  assert.equal(removed.status, 200);
  assert.deepEqual((await (await fetch(`${url}api/state`)).json()).projects, []);
});

test("starts the dashboard in the background and reports its dynamic URL", async (t) => {
  const repo = createGitRepo(t, "serve-background");
  const livetreeHome = tempDir("serve-background-home", t);
  writeFileSync(path.join(repo, ".ltconf"), "name: background\n");

  const result = spawnSync(process.execPath, [cliPath, "server", "start", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, LIVETREE_HOME: livetreeHome, LIVETREE_TAILSCALE_BIN: path.join(livetreeHome, "missing-tailscale") },
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const url = /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(result.stdout)?.[1];
  const pid = Number.parseInt(/background \(pid (\d+)\)/.exec(result.stderr)?.[1] ?? "", 10);
  assert.ok(url);
  assert.ok(Number.isInteger(pid));
  const infoPath = path.join(livetreeHome, "serve.json");
  const info = JSON.parse(readFileSync(infoPath, "utf8"));
  assert.equal(info.pid, pid);
  assert.equal(info.localUrl, url);
  assert.equal(info.tailnetUrl, null);
  assert.match(info.tailnetError, /not executable/);
  assert.match(result.stderr, /Tailnet dashboard unavailable/);
  t.after(() => {
    try { process.kill(pid, "SIGTERM"); } catch {}
  });

  const state = await fetch(`${url}api/state`);
  assert.equal(state.status, 200);
  assert.equal((await state.json()).projects[0].name, "background");
  assert.equal((await (await fetch(`${url}api/state`)).json()).tailnet.status, "unavailable");
  const health = await fetch(`${url}api/health`);
  const healthJson = await health.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.service, "livetree");
  assert.equal(healthJson.pid, pid);
  assert.match(healthJson.dashboard.version, /^[a-f0-9]{16}$/);
  assert.equal(healthJson.dashboard.mobileClient, true);
  assert.equal(healthJson.dashboard.protocolVersion, 1);
  const stopped = spawnSync(process.execPath, [cliPath, "server", "stop"], {
    cwd: repo,
    env: { ...process.env, LIVETREE_HOME: livetreeHome },
    encoding: "utf8",
    timeout: 7_000,
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, new RegExp(`Stopped background LiveTree server \\(pid ${pid}\\)`));
  await waitForProcessExit(pid);
  assert.equal(existsSync(infoPath), false);
});

test("reports background startup failures to the invoking terminal", async (t) => {
  const repo = createGitRepo(t, "serve-background-failure");
  const livetreeHome = tempDir("serve-background-failure-home", t);
  writeFileSync(path.join(repo, ".ltconf"), "name: background-failure\n");
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => blocker.close());
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");

  const result = spawnSync(process.execPath, [cliPath, "server", "start", "--port", String(address.port)], {
    cwd: repo,
    env: { ...process.env, LIVETREE_HOME: livetreeHome },
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EADDRINUSE/);
  assert.equal(existsSync(path.join(livetreeHome, "serve.json")), false);
});

test("server stop rejects a missing or stale background instance", (t) => {
  const cwd = tempDir("server-stop-empty", t);
  const livetreeHome = tempDir("server-stop-empty-home", t);
  const result = spawnSync(process.execPath, [cliPath, "server", "stop"], {
    cwd,
    env: { ...process.env, LIVETREE_HOME: livetreeHome },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No background LiveTree server is running/);
});

test("prefers the current configured project when resolving serve", async (t) => {
  const currentRepo = createGitRepo(t, "serve-current");
  const savedRepo = createGitRepo(t, "serve-saved");
  const livetreeHome = tempDir("serve-current-home", t);
  writeFileSync(path.join(currentRepo, ".ltconf"), "name: current\n");
  writeFileSync(path.join(savedRepo, ".ltconf"), "name: saved\n");

  await withEnv({ LIVETREE_HOME: livetreeHome }, async () => {
    registerProject(savedRepo, 20);
    const context = resolveServeContext(currentRepo);
    assert.equal(context.mainRoot, currentRepo);
  });
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

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Process ${pid} did not exit`);
}
