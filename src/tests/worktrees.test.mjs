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

test("keeps T3 thread metadata authoritative over a newer raw provider transcript", async (t) => {
  const codexHome = tempDir("t3-context-codex", t);
  const claudeHome = tempDir("t3-context-claude", t);
  const cursorHome = tempDir("t3-context-cursor", t);
  const t3Database = path.join(tempDir("t3-context", t), "state.sqlite");
  const repo = createGitRepo(t, "t3-context-repo");
  const linked = path.join(tempDir("t3-context-linked", t), "feature");
  execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: repo, stdio: "ignore" });
  const claudeProject = path.join(claudeHome, "projects", linked.replaceAll(/[^a-zA-Z0-9_-]/g, "-"));
  mkdirSync(claudeProject, { recursive: true });
  writeFileSync(path.join(claudeProject, "raw-session-id.jsonl"), `${JSON.stringify({
    type: "user",
    sessionId: "raw-session-id",
    cwd: linked,
    timestamp: "2099-08-22T11:00:00.000Z",
  })}\n`);
  execFileSync("sqlite3", [t3Database, `
    create table projection_threads (
      thread_id text primary key, title text not null, worktree_path text,
      created_at text not null, updated_at text not null,
      latest_user_message_at text, deleted_at text
    );
    create table projection_thread_sessions (thread_id text primary key, provider_name text);
    insert into projection_threads values (
      't3-thread', 'Generated T3 title', '${linked.replaceAll("'", "''")}',
      '2026-08-22T10:00:00.000Z', '2026-08-22T10:30:00.000Z', '2026-08-22T10:00:00.000Z', null
    );
    insert into projection_thread_sessions values ('t3-thread', 'codex');
  `]);

  await withEnv({ CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, CURSOR_USER_DIR: cursorHome, T3_STATE_DB: t3Database }, async () => {
    const choice = buildProjectContext(repo).choices.find((candidate) => candidate.path === linked);
    assert.equal(choice?.chat?.title, "Generated T3 title");
    assert.equal(choice?.chat?.provider, "codex");
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
