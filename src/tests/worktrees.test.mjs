import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildProjectContext, isWorktreeInitialized, markWorktreeInitialized, uninitializedWorktreesNewestFirst, worktreeListItemsModifiedNewestFirst, worktreesModifiedNewestFirst } from "../../dist/worktrees.js";
import { createGitRepo, makeChoice, tempDir, withEnv } from "./helpers.mjs";

test("builds project context from a git repo and linked worktree", async (t) => {
  const codeHome = tempDir("codex-home", t);
  const claudeHome = tempDir("claude-home", t);
  await withEnv({ CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codeHome }, async () => {
    const repo = createGitRepo(t, "worktree-context");
    const linked = path.join(tempDir("linked-parent", t), "feature");
    execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: repo, stdio: "ignore" });
    const sqliteDir = path.join(codeHome, "sqlite");
    const db = path.join(sqliteDir, "codex-dev.db");
    mkdirSync(sqliteDir, { recursive: true });
    execFileSync("sqlite3", [
      db,
      `create table local_thread_catalog (
        display_title text,
        thread_id text,
        cwd text,
        missing_candidate integer,
        source_updated_at integer
      );
      insert into local_thread_catalog values ('Older Chat', 'thread-older', ${sqlQuote(linked)}, 0, 1);
      insert into local_thread_catalog values ('Newer Chat', 'thread-newer', ${sqlQuote(linked)}, 0, 2);`,
    ]);
    const claudeProject = path.join(claudeHome, "projects", encodeClaudeProjectPath(linked));
    mkdirSync(claudeProject, { recursive: true });
    writeFileSync(path.join(claudeProject, "claude-thread.jsonl"), [
      JSON.stringify({
        type: "user",
        sessionId: "claude-thread",
        cwd: linked,
        slug: "claude-feature-chat",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      "",
    ].join("\n"));

    const context = buildProjectContext(linked);
    assert.equal(context.mainRoot, repo);
    assert.equal(context.liveDir, path.join(repo, ".livetree"));
    assert.equal(context.choices.length, 2);
    assert.equal(context.choices[0].isMain, true);
    const linkedChoice = context.choices.find((choice) => choice.path === linked);
    assert.equal(linkedChoice?.ref, "feature");
    assert.equal(linkedChoice?.label, "claude-feature-chat (+2) [feature]");
    assert.deepEqual(linkedChoice?.chats.map((chat) => chat.title), ["claude-feature-chat", "Newer Chat", "Older Chat"]);
  });
});

function sqlQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodeClaudeProjectPath(value) {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

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
    makeChoice({
      path: newer,
      label: "Newer (+1)",
      chat: { provider: "codex", id: "thread-123", title: "Chat Title" },
      chats: [
        { provider: "codex", id: "thread-123", title: "Chat Title" },
        { provider: "claude", id: "thread-456", title: "Second Chat" },
      ],
    }),
  ];

  const modified = worktreesModifiedNewestFirst(choices);
  assert.equal(modified.length, 2);

  const items = worktreeListItemsModifiedNewestFirst(choices);
  assert.equal(items.length, 2);
  assert.ok(items.some((item) => item.searchText.includes("Chat Title") && item.searchText.includes("thread-123")));
  assert.ok(items.some((item) => item.searchText.includes("Second Chat") && item.searchText.includes("thread-456")));

  markWorktreeInitialized(makeChoice({ path: older }));
  assert.deepEqual(uninitializedWorktreesNewestFirst(choices).map((choice) => choice.path), [newer]);
});
