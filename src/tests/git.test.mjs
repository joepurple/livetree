import assert from "node:assert/strict";
import test from "node:test";
import { formatGitFailure, git, gitCommonDir, parseWorktreeList, stripHeadsPrefix } from "../../dist/git.js";
import { createGitRepo } from "./helpers.mjs";

test("parses git worktree porcelain output", () => {
  const records = parseWorktreeList(`worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-linked
HEAD def456
prunable gitdir file points to missing location

worktree /bare
bare
`);

  assert.deepEqual(records, [
    { path: "/repo", head: "abc123", branch: "main", bare: false, prunable: null },
    { path: "/repo-linked", head: "def456", branch: null, bare: false, prunable: "gitdir file points to missing location" },
    { path: "/bare", head: null, branch: null, bare: true, prunable: null },
  ]);
});

test("formats git helpers", (t) => {
  const repo = createGitRepo(t, "git-helper");
  assert.equal(stripHeadsPrefix("refs/heads/main"), "main");
  assert.match(git(["rev-parse", "--show-toplevel"], repo), /livetree-git-helper/);
  assert.ok(gitCommonDir(repo).endsWith(".git"));
  assert.equal(formatGitFailure({ stderr: " fatal\n" }, "git nope"), "git nope failed:\nfatal");
  assert.equal(formatGitFailure({}, "git nope"), "git nope failed.");
  assert.throws(() => git(["definitely-not-a-git-command"], repo, "custom message"), /custom message/);
});
