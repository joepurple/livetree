import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { cliPath, tempDir } from "./helpers.mjs";

test("CLI prints help without requiring a git worktree", () => {
  const output = execFileSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.match(output, /Usage:/);
  assert.match(output, /lt watch:/);
});

test("CLI reports a friendly error outside git", (t) => {
  const cwd = tempDir("cli-outside-git", t);
  const result = spawnSync(process.execPath, [cliPath], { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lt must be run inside a Git worktree/);
});
