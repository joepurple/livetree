import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { archiveRemovedCodexChat, codexChatForPath, codexThreadIdForChoice, syncedBranchForPath, threadIdForPath } from "../../dist/codex.js";
import { createGitRepo, makeChoice, tempDir, withEnv } from "./helpers.mjs";

test("reads Codex metadata from a worktree git dir", async (t) => {
  const codexHome = tempDir("codex-empty", t);
  await withEnv({ CODEX_HOME: codexHome }, async () => {
    const repo = createGitRepo(t, "codex-meta");
    const gitdir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repo, encoding: "utf8" }).trim();
    const absoluteGitdir = path.isAbsolute(gitdir) ? gitdir : path.join(repo, gitdir);
    mkdirSync(absoluteGitdir, { recursive: true });
    writeFileSync(path.join(absoluteGitdir, "codex-thread.json"), JSON.stringify({ ownerThreadId: "thread-abc" }));
    writeFileSync(path.join(absoluteGitdir, "codex-synced-branch.json"), JSON.stringify({ branch: "refs/heads/feature" }));

    assert.equal(threadIdForPath(repo), "thread-abc");
    assert.equal(syncedBranchForPath(repo), "feature");
    assert.equal(codexThreadIdForChoice(makeChoice({ path: repo })), "thread-abc");
    assert.equal(codexThreadIdForChoice(makeChoice({ path: repo, chat: { title: "Chat", threadId: "chat-thread" } })), "chat-thread");
    assert.equal(codexChatForPath(repo), null);
    archiveRemovedCodexChat(makeChoice({ path: repo }), null);
  });
});
