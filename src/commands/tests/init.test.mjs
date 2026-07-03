import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorktree } from "../../../dist/commands/init.js";
import { captureConsole, makeChoice, makeContext, tempDir } from "../../tests/helpers.mjs";

test("initWorktree copies configured files, runs script, and marks worktrees", async (t) => {
  const root = tempDir("init-root", t);
  const target = path.join(root, "target");
  mkdirSync(target);
  mkdirSync(path.join(root, ".livetree"));
  writeFileSync(path.join(root, ".env"), "SECRET=1\n");
  writeFileSync(path.join(root, ".ltconf"), `
init:
  copy:
    - .env
  script: |
    node -e "require('fs').writeFileSync('init-ran.txt','yes')"
`);

  const context = makeContext(root, [
    makeChoice({ path: root, label: "ROOT", isMain: true }),
    makeChoice({ path: target, label: "Target" }),
  ]);

  await initWorktree(context);
  assert.equal(readFileSync(path.join(target, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(readFileSync(path.join(target, "init-ran.txt"), "utf8"), "yes");
  assert.equal(readFileSync(path.join(target, ".livetree", ".source"), "utf8"), `${target}\n`);
});

test("initWorktree requires an init script", async (t) => {
  const root = tempDir("init-missing-script", t);
  mkdirSync(path.join(root, ".livetree"));
  writeFileSync(path.join(root, ".ltconf"), "run:\n  web: npm start\n");
  const target = path.join(root, "target");
  mkdirSync(target);

  await assert.rejects(
    initWorktree(makeContext(root, [makeChoice({ path: target, label: "Target" })])),
    /must define an init script/,
  );
  assert.equal(existsSync(path.join(target, ".livetree")), false);
});

test("initWorktree reports when every worktree is initialized", async (t) => {
  const root = tempDir("init-none", t);
  mkdirSync(path.join(root, ".livetree"));
  writeFileSync(path.join(root, ".ltconf"), "init:\n  script: echo ok\n");

  const { logs } = await captureConsole(() =>
    initWorktree(makeContext(root, [makeChoice({ path: root, label: "ROOT", isMain: true })])),
  );

  assert.ok(logs.some((line) => line.includes("No uninitialized worktrees found.")));
});
