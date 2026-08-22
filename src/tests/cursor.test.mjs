import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { cursorMetadataForPaths } from "../../dist/cursor.js";
import { tempDir, withEnv } from "./helpers.mjs";

test("maps Cursor composer headers to worktree paths and fails closed", async (t) => {
  const userDir = tempDir("cursor", t);
  const worktree = tempDir("cursor-worktree", t);
  const globalStorage = path.join(userDir, "globalStorage");
  const workspace = path.join(userDir, "workspaceStorage", "workspace-1");
  mkdirSync(globalStorage, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "workspace.json"), JSON.stringify({ folder: new URL(`file://${worktree}`).href }));
  const db = path.join(globalStorage, "state.vscdb");
  const value = JSON.stringify({ name: "Cursor chat" }).replaceAll("'", "''");
  execFileSync("sqlite3", [db, `create table composerHeaders (composerId text, workspaceId text, lastUpdatedAt integer, value text, isSubagent integer); insert into composerHeaders values ('chat-1','workspace-1',100,'${value}',0);`]);
  await withEnv({ CURSOR_USER_DIR: userDir }, async () => {
    const metadata = cursorMetadataForPaths([worktree]).get(worktree);
    assert.equal(metadata.chat.title, "Cursor chat");
    assert.equal(metadata.chat.provider, "cursor");
  });
  await withEnv({ CURSOR_USER_DIR: path.join(userDir, "missing") }, async () => {
    assert.deepEqual(cursorMetadataForPaths([worktree]).get(worktree), { chat: null, chats: [] });
  });
});
