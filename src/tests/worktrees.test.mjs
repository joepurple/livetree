import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildProjectContext, isWorktreeInitialized, markWorktreeInitialized, uninitializedWorktreesNewestFirst, worktreesModifiedNewestFirst } from "../../dist/worktrees.js";
import { createGitRepo, makeChoice, tempDir, withEnv } from "./helpers.mjs";

test("builds context, including chat metadata for the main worktree", async (t) => {
  const codexHome = tempDir("context-codex", t);
  const claudeHome = tempDir("context-claude", t);
  await withEnv({ CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, CURSOR_USER_DIR: tempDir("cursor-empty", t) }, async () => {
    const repo = createGitRepo(t, "context");
    const project = path.join(claudeHome, "projects", repo.replaceAll(/[^a-zA-Z0-9_-]/g, "-"));
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "chat.jsonl"), `${JSON.stringify({ type: "user", sessionId: "c1", cwd: repo, slug: "Main chat" })}\n`);
    const linked = path.join(tempDir("linked", t), "feature");
    execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: repo, stdio: "ignore" });
    const context = buildProjectContext(repo);
    assert.equal(context.mainRoot, repo);
    assert.equal(context.stateDir, path.join(repo, ".livetree", "state"));
    assert.equal(context.choices.length, 2);
    assert.equal(context.choices[0].chats[0].title, "Main chat");
  });
});

test("tracks initialization with .livetree/initialized and sorts choices", (t) => {
  const older = tempDir("older", t);
  const newer = tempDir("newer", t);
  const oldChoice = makeChoice({ path: older });
  const newChoice = makeChoice({ path: newer });
  assert.equal(isWorktreeInitialized(oldChoice), false);
  markWorktreeInitialized(oldChoice);
  assert.equal(isWorktreeInitialized(oldChoice), true);
  assert.ok(existsSync(path.join(older, ".livetree", "initialized")));
  assert.deepEqual(uninitializedWorktreesNewestFirst([oldChoice, newChoice]).map((choice) => choice.path), [newer]);
  assert.equal(worktreesModifiedNewestFirst([oldChoice, newChoice]).length, 2);
});
