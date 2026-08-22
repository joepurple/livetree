import assert from "node:assert/strict";
import test from "node:test";
import { git, gitCommonDir, parseWorktreeList, stripHeadsPrefix } from "../../dist/git.js";
import { createGitRepo } from "./helpers.mjs";

test("parses git worktree porcelain output", () => {
  assert.deepEqual(parseWorktreeList(`worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /linked\nHEAD def\nprunable missing\n\nworktree /bare\nbare\n`), [
    { path: "/repo", head: "abc", branch: "main", bare: false, prunable: null },
    { path: "/linked", head: "def", branch: null, bare: false, prunable: "missing" },
    { path: "/bare", head: null, branch: null, bare: true, prunable: null },
  ]);
});

test("runs git helpers", (t) => {
  const repo = createGitRepo(t, "git");
  assert.equal(stripHeadsPrefix("refs/heads/main"), "main");
  assert.match(git(["rev-parse", "--show-toplevel"], repo), /livetree-git/);
  assert.ok(gitCommonDir(repo).endsWith(".git"));
  assert.throws(() => git(["not-a-command"], repo, "custom"), /custom/);
});
