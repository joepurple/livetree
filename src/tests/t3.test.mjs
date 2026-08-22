import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { t3MetadataForPaths, t3StatePath } from "../../dist/t3.js";
import { tempDir, withEnv } from "./helpers.mjs";

test("uses the most recently active T3 thread title and provider for a worktree", async (t) => {
  const root = tempDir("t3", t);
  const database = path.join(root, "state.sqlite");
  const worktree = path.join(root, "feature's-worktree");
  createT3Database(database);
  insertThread(database, {
    id: "older-thread",
    title: "Older Claude title",
    worktree,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T11:00:00.000Z",
    latestUserMessageAt: "2026-08-22T12:00:00.000Z",
    provider: "claudeAgent",
  });
  insertThread(database, {
    id: "newer-thread",
    title: "Newest Codex title",
    worktree,
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T11:00:00.000Z",
    latestUserMessageAt: "2026-08-21T10:30:00.000Z",
    provider: "codex",
  });

  await withEnv({ T3_STATE_DB: database }, async () => {
    assert.equal(t3StatePath(), database);
    const metadata = t3MetadataForPaths([worktree]).get(worktree);
    assert.deepEqual(metadata?.chats.map(({ provider, id, title }) => ({ provider, id, title })), [
      { provider: "codex", id: "newer-thread", title: "Newest Codex title" },
      { provider: "claude", id: "older-thread", title: "Older Claude title" },
    ]);
    assert.equal(metadata?.chat, metadata?.chats[0]);
  });
});

test("ignores deleted T3 threads and unknown providers", async (t) => {
  const root = tempDir("t3-filter", t);
  const database = path.join(root, "state.sqlite");
  const worktree = path.join(root, "worktree");
  createT3Database(database);
  insertThread(database, {
    id: "deleted-thread",
    title: "Deleted title",
    worktree,
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T11:00:00.000Z",
    latestUserMessageAt: null,
    provider: "codex",
    deletedAt: "2026-08-21T12:00:00.000Z",
  });
  insertThread(database, {
    id: "unknown-thread",
    title: "Unknown provider",
    worktree,
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T11:00:00.000Z",
    latestUserMessageAt: null,
    provider: "otherAgent",
  });

  await withEnv({ T3_STATE_DB: database }, async () => {
    assert.deepEqual(t3MetadataForPaths([worktree]).get(worktree), { chat: null, chats: [] });
  });
});

function createT3Database(database) {
  execFileSync("sqlite3", [database, `
    create table projection_threads (
      thread_id text primary key,
      title text not null,
      worktree_path text,
      created_at text not null,
      updated_at text not null,
      latest_user_message_at text,
      deleted_at text
    );
    create table projection_thread_sessions (
      thread_id text primary key,
      provider_name text
    );
  `]);
}

function insertThread(database, thread) {
  execFileSync("sqlite3", [database, `
    insert into projection_threads values (
      ${sql(thread.id)}, ${sql(thread.title)}, ${sql(thread.worktree)},
      ${sql(thread.createdAt)}, ${sql(thread.updatedAt)}, ${sql(thread.latestUserMessageAt)}, ${sql(thread.deletedAt ?? null)}
    );
    insert into projection_thread_sessions values (${sql(thread.id)}, ${sql(thread.provider)});
  `]);
}

function sql(value) {
  return value === null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
}
