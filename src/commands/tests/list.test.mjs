import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { listWorktrees } from "../../../dist/commands/list.js";
import { writeServerEntry } from "../../../dist/registry.js";
import { captureConsole, makeChoice, makeContext, tempDir } from "../../tests/helpers.mjs";

test("prints one entry per worktree and registered servers without chat-history noise", async (t) => {
  const root = tempDir("list", t);
  const linked = path.join(root, "linked");
  mkdirSync(linked);
  const choice = makeChoice({
    path: linked,
    label: "Feature [feature]",
    chats: [{ provider: "cursor", id: "1", title: "Fix login" }, { provider: "codex", id: "2", title: "Write tests" }],
  });
  const context = makeContext(root, [choice]);
  writeServerEntry(context.stateDir, {
    name: "app-feature-web", script: "web", worktree: linked, pid: process.pid,
    url: "https://app-feature-web.localhost", envFingerprint: "abc", tunneled: false,
    startedAtMs: Date.now(), managed: false, logPath: null,
  });
  const { logs } = await captureConsole(() => listWorktrees(context));
  const output = logs.join("\n");
  assert.match(output, /Feature/);
  assert.doesNotMatch(output, /cursor: Fix login/);
  assert.doesNotMatch(output, /codex: Write tests/);
  assert.match(output, /https:\/\/app-feature-web.localhost/);
  await assert.rejects(listWorktrees(context, "extra"), /Usage: livetree ls/);
});

test("does not print the main checkout path", async (t) => {
  const root = tempDir("list-main", t);
  const context = makeContext(root, [makeChoice({ path: root, label: "main [main]", isMain: true })]);
  const { logs } = await captureConsole(() => listWorktrees(context));
  assert.ok(logs.some((line) => line.includes("main [main]")));
  assert.ok(!logs.some((line) => line.trim() === root));
});
