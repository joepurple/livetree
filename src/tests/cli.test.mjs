import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { cliPath, createGitRepo, tempDir } from "./helpers.mjs";

test("help exposes only the revamped command surface", () => {
  const output = execFileSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  for (const command of ["livetree init", "livetree ls", "livetree dev", "livetree tunnel", "livetree serve"]) {
    assert.match(output, new RegExp(command));
  }
  for (const removed of [" use ", " cd ", " watch ", " rm ", "install tools", "@<selector>"]) {
    assert.doesNotMatch(output, new RegExp(removed));
  }
});

test("blank invocation prints usage and commands needing a repo fail clearly outside git", (t) => {
  const cwd = tempDir("cli-outside", t);
  const blank = spawnSync(process.execPath, [cliPath], { cwd, encoding: "utf8" });
  assert.notEqual(blank.status, 0);
  assert.match(blank.stderr, /Usage:/);
  const list = spawnSync(process.execPath, [cliPath, "ls"], { cwd, encoding: "utf8" });
  assert.notEqual(list.status, 0);
  assert.match(list.stderr, /livetree must be run inside a Git worktree/);
});

test("ls is wired and removed commands become unknown script names", (t) => {
  const repo = createGitRepo(t, "cli-repo");
  writeFileSync(path.join(repo, ".ltconf"), "dev:\n  web: node server.mjs\n");
  const list = spawnSync(process.execPath, [cliPath, "ls"], { cwd: repo, encoding: "utf8" });
  assert.equal(list.status, 0);
  assert.match(list.stdout, /main \[main\]/);
  for (const command of ["use", "cd", "watch", "rm", "__complete"]) {
    const result = spawnSync(process.execPath, [cliPath, command], { cwd: repo, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown command or dev script/);
  }
});
