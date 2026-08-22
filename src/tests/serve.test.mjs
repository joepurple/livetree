import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { cliPath, createGitRepo } from "./helpers.mjs";

test("serves dashboard HTML and JSON on loopback", async (t) => {
  const repo = createGitRepo(t, "serve");
  writeFileSync(path.join(repo, ".ltconf"), `name: demo\ndev:\n  web: node server.mjs\nlinks:\n  web: \${url:web}\n`);
  const child = spawn(process.execPath, [cliPath, "serve", "--port", "0"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const output = await waitForOutput(child.stdout, /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/);
  const url = /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output)[1];
  const html = await fetch(url);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<title>livetree<\/title>/);
  const state = await fetch(`${url}api/state`);
  assert.equal(state.status, 200);
  const json = await state.json();
  assert.equal(json.project, "demo");
  assert.equal(json.worktrees[0].scripts[0].script, "web");
  assert.equal(json.worktrees[0].links[0].url, "https://demo-main-web.localhost:1355");
  assert.equal("chats" in json.worktrees[0], false);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
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
