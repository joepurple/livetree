import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorktree } from "../../../dist/commands/init.js";
import { captureConsole, makeChoice, makeContext, tempDir } from "../../tests/helpers.mjs";

test("copies missing files, runs init, and writes the initialized marker", async (t) => {
  const root = tempDir("init", t);
  const target = path.join(root, "target");
  mkdirSync(target);
  writeFileSync(path.join(root, ".env"), "SECRET=1\n");
  writeFileSync(path.join(root, ".ltconf"), `init:\n  copy: [.env]\n  script: node -e "require('fs').writeFileSync('ran','yes')"\n`);
  const context = makeContext(root, [
    makeChoice({ path: root, label: "main", isMain: true }),
    makeChoice({ path: target, label: "target" }),
  ]);
  await initWorktree(context);
  assert.equal(readFileSync(path.join(target, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(readFileSync(path.join(target, "ran"), "utf8"), "yes");
  assert.ok(existsSync(path.join(target, ".livetree", "initialized")));
  assert.ok(existsSync(path.join(root, ".livetree", "initialized")));
});

test("requires init behavior and reports when all worktrees are initialized", async (t) => {
  const root = tempDir("init-empty", t);
  writeFileSync(path.join(root, ".ltconf"), "name: sample\n");
  await assert.rejects(initWorktree(makeContext(root, [makeChoice({ path: root })])), /must define an init section/);
  writeFileSync(path.join(root, ".ltconf"), "init:\n  script: echo ok\n");
  mkdirSync(path.join(root, ".livetree"), { recursive: true });
  writeFileSync(path.join(root, ".livetree", "initialized"), "yes\n");
  const { logs } = await captureConsole(() => initWorktree(makeContext(root, [makeChoice({ path: root })])));
  assert.ok(logs.some((line) => line.includes("No uninitialized worktrees")));
});
