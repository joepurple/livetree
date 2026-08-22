import assert from "node:assert/strict";
import test from "node:test";
import { git, gitAsync, gitCommonDir, parseWorktreeList, stripHeadsPrefix } from "../../dist/git.js";
import { createGitRepo } from "./helpers.mjs";

test("parses git worktree porcelain output", () => {
  assert.deepEqual(parseWorktreeList(`worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /linked\nHEAD def\nprunable missing\n\nworktree /bare\nbare\n`), [
    { path: "/repo", head: "abc", branch: "main", bare: false, prunable: null },
    { path: "/linked", head: "def", branch: null, bare: false, prunable: "missing" },
    { path: "/bare", head: null, branch: null, bare: true, prunable: null },
  ]);
});

test("runs git helpers", async (t) => {
  const repo = createGitRepo(t, "git");
  assert.equal(stripHeadsPrefix("refs/heads/main"), "main");
  assert.match(git(["rev-parse", "--show-toplevel"], repo), /livetree-git/);
  assert.match(await gitAsync(["rev-parse", "--show-toplevel"], repo), /livetree-git/);
  assert.ok(gitCommonDir(repo).endsWith(".git"));
  assert.throws(() => git(["not-a-command"], repo, "custom"), /custom/);
  await assert.rejects(gitAsync(["not-a-command"], repo, "custom async"), /custom async/);
});

test("runs asynchronous git without blocking the event loop", async (t) => {
  const repo = createGitRepo(t, "git-async");
  const command = gitAsync(["-c", "alias.livetree-wait=!sleep 0.2", "livetree-wait"], repo);
  const first = await Promise.race([
    command.then(() => "git"),
    new Promise((resolve) => setTimeout(() => resolve("timer"), 25)),
  ]);
  assert.equal(first, "timer");
  await command;
});
