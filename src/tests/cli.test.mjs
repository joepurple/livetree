import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { cliPath, createGitRepo, tempDir } from "./helpers.mjs";

test("CLI prints help without requiring a git worktree", () => {
  const output = execFileSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.match(output, /Usage:/);
  assert.match(output, /lt switcher/);
  assert.match(output, /lt watch:/);
});

test("CLI reports a friendly error outside git", (t) => {
  const cwd = tempDir("cli-outside-git", t);
  const result = spawnSync(process.execPath, [cliPath], { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lt must be run inside a Git worktree/);
});

test("blank CLI opens the switcher", (t) => {
  const cwd = createGitRepo(t, "cli-blank-switcher");
  const result = spawnSync(process.execPath, [cliPath], { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Open the switcher from an interactive terminal/);
});
