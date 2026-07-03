import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildProjectContext, isWorktreeInitialized, markWorktreeInitialized, uninitializedWorktreesNewestFirst, worktreeListItemsModifiedNewestFirst, worktreesModifiedNewestFirst } from "../../dist/worktrees.js";
import { createGitRepo, makeChoice, tempDir, withEnv } from "./helpers.mjs";

test("builds project context from a git repo and linked worktree", async (t) => {
  const codeHome = tempDir("codex-home", t);
  await withEnv({ CODEX_HOME: codeHome }, async () => {
    const repo = createGitRepo(t, "worktree-context");
    const linked = path.join(tempDir("linked-parent", t), "feature");
    execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: repo, stdio: "ignore" });

    const context = buildProjectContext(linked);
    assert.equal(context.mainRoot, repo);
    assert.equal(context.liveDir, path.join(repo, ".livetree"));
    assert.equal(context.choices.length, 2);
    assert.equal(context.choices[0].isMain, true);
    assert.ok(context.choices.some((choice) => choice.path === linked && choice.ref === "feature"));
  });
});

test("tracks worktree initialization markers", (t) => {
  const root = tempDir("init-marker", t);
  const choice = makeChoice({ path: root });
  assert.equal(isWorktreeInitialized(choice), false);
  markWorktreeInitialized(choice);
  assert.equal(isWorktreeInitialized(choice), true);
  assert.equal(existsSync(path.join(root, ".livetree", ".source")), true);

  const blocked = tempDir("blocked-marker", t);
  writeFileSync(path.join(blocked, ".livetree"), "file");
  assert.throws(() => isWorktreeInitialized(makeChoice({ path: blocked })), /exists and is not a directory/);
});

test("sorts worktrees and creates search text", (t) => {
  const older = tempDir("older-worktree", t);
  const newer = tempDir("newer-worktree", t);
  mkdirSync(path.join(newer, "nested"));
  const choices = [
    makeChoice({ path: older, label: "Older", branch: "older" }),
    makeChoice({ path: newer, label: "Newer", chat: { title: "Chat Title", threadId: "thread-123" } }),
  ];

  const modified = worktreesModifiedNewestFirst(choices);
  assert.equal(modified.length, 2);

  const items = worktreeListItemsModifiedNewestFirst(choices);
  assert.equal(items.length, 2);
  assert.ok(items.some((item) => item.searchText.includes("Chat Title") && item.searchText.includes("thread-123")));

  markWorktreeInitialized(makeChoice({ path: older }));
  assert.deepEqual(uninitializedWorktreesNewestFirst(choices).map((choice) => choice.path), [newer]);
});
