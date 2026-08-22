import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { codexMetadataForPaths } from "../../dist/codex.js";
import { createGitRepo, tempDir, withEnv } from "./helpers.mjs";

test("maps Codex catalog chats and gitdir metadata to a worktree", async (t) => {
  const home = tempDir("codex", t);
  await withEnv({ CODEX_HOME: home }, async () => {
    const repo = createGitRepo(t, "codex-repo");
    const gitdir = path.join(repo, ".git");
    writeFileSync(path.join(gitdir, "codex-thread.json"), JSON.stringify({ ownerThreadId: "thread-1" }));
    writeFileSync(path.join(gitdir, "codex-synced-branch.json"), JSON.stringify({ branch: "refs/heads/feature" }));
    const sqliteDir = path.join(home, "sqlite");
    mkdirSync(sqliteDir, { recursive: true });
    const db = path.join(sqliteDir, "codex-dev.db");
    execFileSync("sqlite3", [db, `create table local_thread_catalog (display_title text, thread_id text, cwd text, missing_candidate integer, source_updated_at integer); insert into local_thread_catalog values ('Implement dashboard','thread-1','${repo.replaceAll("'", "''")}',0,42);`]);
    const metadata = codexMetadataForPaths([repo]).get(repo);
    assert.equal(metadata.syncedBranch, "feature");
    assert.equal(metadata.threadId, "thread-1");
    assert.equal(metadata.chat.title, "Implement dashboard");
  });
});
