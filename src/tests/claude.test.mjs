import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  claudeMetadataForPaths,
  claudeProjectDirectoriesForWorktrees,
  claudeProjectsPath,
  claudeTranscriptPathsForWorktrees,
} from "../../dist/claude.js";
import { tempDir, withEnv } from "./helpers.mjs";

test("finds Claude chats by every worktree cwd used in a session", async (t) => {
  const claudeHome = tempDir("claude-home", t);
  const project = tempDir("claude-project", t);
  const worktree = path.join(project, ".claude", "worktrees", "feature");
  mkdirSync(worktree, { recursive: true });

  await withEnv({ CLAUDE_CONFIG_DIR: claudeHome }, async () => {
    const projectDirectory = path.join(claudeProjectsPath(), encodeProjectPath(project));
    mkdirSync(projectDirectory, { recursive: true });
    const transcript = path.join(projectDirectory, "session-123.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", sessionId: "session-123", cwd: project, timestamp: "2026-01-01T00:00:00.000Z" }),
      "{malformed",
      JSON.stringify({
        type: "assistant",
        sessionId: "session-123",
        cwd: worktree,
        slug: "bright-running-otter",
        timestamp: "2026-01-02T00:00:00.000Z",
      }),
      JSON.stringify({ type: "custom-title", sessionId: "session-123", customTitle: "Claude Feature Chat" }),
      "",
    ].join("\n"));

    assert.deepEqual(claudeProjectDirectoriesForWorktrees([worktree]), [projectDirectory]);
    assert.deepEqual(claudeTranscriptPathsForWorktrees([worktree]), [transcript]);

    const metadata = claudeMetadataForPaths([project, worktree]);
    assert.deepEqual(metadata.get(worktree)?.chat, {
      provider: "claude",
      id: "session-123",
      title: "Claude Feature Chat",
      updatedAtMs: assertPositiveNumber(metadata.get(worktree)?.chat?.updatedAtMs),
    });
    assert.equal(metadata.get(project)?.chat?.id, "session-123");
  });
});

test("uses the Claude slug when a chat has no custom title", async (t) => {
  const claudeHome = tempDir("claude-slug-home", t);
  const worktree = tempDir("claude-slug-worktree", t);

  await withEnv({ CLAUDE_CONFIG_DIR: claudeHome }, async () => {
    const projectDirectory = path.join(claudeProjectsPath(), encodeProjectPath(worktree));
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(path.join(projectDirectory, "session-456.jsonl"), `${JSON.stringify({
      type: "user",
      sessionId: "session-456",
      cwd: worktree,
      slug: "calm-coding-fox",
    })}\n`);

    assert.equal(claudeMetadataForPaths([worktree]).get(worktree)?.chat?.title, "calm-coding-fox");
  });
});

function encodeProjectPath(value) {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

function assertPositiveNumber(value) {
  assert.equal(typeof value, "number");
  assert.ok(value > 0);
  return value;
}
