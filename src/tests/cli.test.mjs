import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { cliPath, createGitRepo, tempDir } from "./helpers.mjs";

test("CLI prints help without requiring a git worktree", () => {
  const output = execFileSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.match(output, /Usage:/);
  assert.match(output, /lt cd/);
  assert.match(output, /lt watch:/);
  assert.match(output, /lt install tools/);
  assert.doesNotMatch(output, /lt switch /);
  assert.doesNotMatch(output, /lt switcher/);
  assert.doesNotMatch(output, /lt list/);
  assert.doesNotMatch(output, /lt go/);
  assert.doesNotMatch(output, /lt remove/);
  assert.doesNotMatch(output, /lt delete/);
  assert.doesNotMatch(output, /lt completion zsh/);
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

test("CLI @selector runs shell commands in the selected worktree", (t) => {
  const repo = createGitRepo(t, "cli-at-shell");
  const linked = path.join(tempDir("cli-at-shell-linked", t), "feature");
  execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: repo, stdio: "ignore" });

  const result = spawnSync(process.execPath, [cliPath, "@feature", ":", "pwd"], { cwd: repo, encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), linked);
});

test("CLI @selector runs scripts in the selected worktree", (t) => {
  const repo = createGitRepo(t, "cli-at-script");
  const linked = path.join(tempDir("cli-at-script-linked", t), "feature");
  execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: repo, stdio: "ignore" });
  writeFileSync(path.join(repo, ".ltconf"), "run:\n  api: pwd\n", "utf8");

  const result = spawnSync(process.execPath, [cliPath, "@feature", "api"], { cwd: repo, encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), linked);
});

test("removed CLI syntaxes are no longer built-ins", (t) => {
  const repo = createGitRepo(t, "cli-removed-syntaxes");

  for (const args of [["switch", "main"], ["switcher"], ["list"], ["go"], ["remove"], ["delete"], ["completion", "zsh"]]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: repo, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown command or run script|No run scripts are defined|No \.ltconf found/);
  }
});

test("CLI completes selectors", (t) => {
  const repo = createGitRepo(t, "cli-complete-selectors");
  const linked = path.join(tempDir("cli-complete-linked", t), "feature-worktree");
  execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: repo, stdio: "ignore" });

  const output = execFileSync(process.execPath, [cliPath, "__complete", "selectors", "fea"], { cwd: repo, encoding: "utf8" });

  assert.match(output, /^feature$/m);
  assert.match(output, /^feature-worktree$/m);
});
