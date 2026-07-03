import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandFailureMessage } from "./errors.js";
import { git, stripHeadsPrefix } from "./git.js";
import type { CodexChat, WorktreeChoice } from "./types.js";

export function codexChatForPath(worktreePath: string): CodexChat | null {
  const byPath = queryCodexCatalog(`select display_title, thread_id
from local_thread_catalog
where missing_candidate = 0
  and cwd = ${sqlQuote(worktreePath)}
order by source_updated_at desc
limit 1;`);

  if (byPath) {
    return byPath;
  }

  const threadId = threadIdForPath(worktreePath);
  if (!threadId) {
    return null;
  }

  return queryCodexCatalog(`select display_title, thread_id
from local_thread_catalog
where missing_candidate = 0
  and thread_id = ${sqlQuote(threadId)}
order by source_updated_at desc
limit 1;`);
}

export function threadIdForPath(worktreePath: string): string | null {
  return readGitdirJsonValue(worktreePath, "codex-thread.json", "ownerThreadId");
}

export function syncedBranchForPath(worktreePath: string): string | null {
  const branch = readGitdirJsonValue(worktreePath, "codex-synced-branch.json", "branch");
  return branch ? stripHeadsPrefix(branch) : null;
}

export function codexThreadIdForChoice(choice: WorktreeChoice): string | null {
  return choice.chat?.threadId || threadIdForPath(choice.path);
}

export function archiveRemovedCodexChat(choice: WorktreeChoice, threadId: string | null): void {
  if (!threadId) {
    return;
  }

  try {
    execFileSync("codex", ["archive", threadId], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(`Archived Codex chat: ${choice.chat?.title || threadId}`);
  } catch (error) {
    process.stderr.write(`Warning: failed to archive Codex chat ${threadId}: ${commandFailureMessage(error)}\n`);
  }
}

function queryCodexCatalog(sql: string): CodexChat | null {
  const db = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sqlite", "codex-dev.db");
  if (!existsSync(db)) {
    return null;
  }

  try {
    const output = execFileSync("sqlite3", ["-separator", "\t", db, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!output) {
      return null;
    }

    const [title, threadId] = output.split("\t");
    if (!title && !threadId) {
      return null;
    }

    return {
      title: title ?? "",
      threadId: threadId ?? "",
    };
  } catch {
    return null;
  }
}

function readGitdirJsonValue(worktreePath: string, filename: string, key: string): string | null {
  let gitdir: string;
  try {
    gitdir = git(["rev-parse", "--git-dir"], worktreePath);
  } catch {
    return null;
  }

  const absoluteGitdir = path.isAbsolute(gitdir) ? gitdir : path.resolve(worktreePath, gitdir);
  const file = path.join(absoluteGitdir, filename);
  if (!existsSync(file)) {
    return null;
  }

  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const value = json[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
