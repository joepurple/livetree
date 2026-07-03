import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { cliPath, createGitRepo, tempDir } from "./helpers.mjs";

test("CLI prints help without requiring a git worktree", () => {
  const output = execFileSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.match(output, /Usage:/);
  assert.match(output, /lt switcher/);
  assert.match(output, /lt watch:/);
  assert.match(output, /lt completion zsh/);
});

test("CLI prints zsh completion without requiring a git worktree", () => {
  const output = execFileSync(process.execPath, [cliPath, "completion", "zsh"], { encoding: "utf8" });
  assert.match(output, /#compdef lt/);
  assert.match(output, /command lt __complete selectors/);
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

test("CLI @selector switches directly", (t) => {
  const repo = createGitRepo(t, "cli-at-selector");
  const linked = path.join(tempDir("cli-at-linked", t), "feature");
  execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: repo, stdio: "ignore" });

  const result = spawnSync(process.execPath, [cliPath, "@feature"], { cwd: repo, encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.equal(readlinkSync(path.join(repo, ".livetree", "src")), linked);
  assert.match(result.stdout, /Active:/);
});

test("CLI completes selectors", (t) => {
  const repo = createGitRepo(t, "cli-complete-selectors");
  const linked = path.join(tempDir("cli-complete-linked", t), "feature-worktree");
  execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: repo, stdio: "ignore" });

  const output = execFileSync(process.execPath, [cliPath, "__complete", "selectors", "fea"], { cwd: repo, encoding: "utf8" });

  assert.match(output, /^feature$/m);
  assert.match(output, /^feature-worktree$/m);
});
