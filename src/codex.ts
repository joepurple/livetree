import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandFailureMessage } from "./errors.js";
import { stripHeadsPrefix } from "./git.js";
import type { Chat, WorktreeChoice } from "./types.js";

export type CodexMetadata = {
  chat: Chat | null;
  chats: Chat[];
  syncedBranch: string | null;
  threadId: string | null;
};

type CodexCatalogRow = Chat & {
  cwd: string;
  threadId: string;
};

export function codexChatForPath(worktreePath: string): Chat | null {
  return codexMetadataForPaths([worktreePath]).get(worktreePath)?.chat ?? null;
}

export function threadIdForPath(worktreePath: string): string | null {
  return readGitdirJsonValue(worktreePath, "codex-thread.json", "ownerThreadId");
}

export function syncedBranchForPath(worktreePath: string): string | null {
  const branch = readGitdirJsonValue(worktreePath, "codex-synced-branch.json", "branch");
  return branch ? stripHeadsPrefix(branch) : null;
}

export function codexThreadIdForChoice(choice: WorktreeChoice): string | null {
  return choice.chats.find((chat) => chat.provider === "codex")?.id
    ?? (choice.chat?.provider === "codex" ? choice.chat.id : null)
    ?? threadIdForPath(choice.path);
}

export function codexMetadataForPaths(worktreePaths: string[]): Map<string, CodexMetadata> {
  const metadata = new Map<string, CodexMetadata>();
  const pathsByThreadId = new Map<string, string[]>();

  for (const worktreePath of worktreePaths) {
    const gitdir = gitdirForPath(worktreePath);
    const threadId = gitdir ? readGitdirJsonValueFromGitdir(gitdir, "codex-thread.json", "ownerThreadId") : null;
    const branch = gitdir ? readGitdirJsonValueFromGitdir(gitdir, "codex-synced-branch.json", "branch") : null;
    const syncedBranch = branch ? stripHeadsPrefix(branch) : null;
    metadata.set(worktreePath, {
      chat: null,
      chats: [],
      syncedBranch,
      threadId,
    });

    if (!threadId) {
      continue;
    }

    const paths = pathsByThreadId.get(threadId) ?? [];
    paths.push(worktreePath);
    pathsByThreadId.set(threadId, paths);
  }

  const rows = queryCodexCatalogRows(worktreePaths, [...pathsByThreadId.keys()]);
  for (const row of rows) {
    appendCodexChat(metadata.get(row.cwd), row);
  }

  for (const row of rows) {
    const paths = pathsByThreadId.get(row.threadId) ?? [];
    for (const worktreePath of paths) {
      appendCodexChat(metadata.get(worktreePath), row);
    }
  }

  return metadata;
}

function appendCodexChat(metadata: CodexMetadata | undefined, row: CodexCatalogRow): void {
  if (!metadata || !row.threadId || metadata.chats.some((chat) => chat.provider === "codex" && chat.id === row.threadId)) {
    return;
  }

  const chat = {
    provider: "codex" as const,
    id: row.threadId,
    title: row.title,
    updatedAtMs: row.updatedAtMs,
  };
  metadata.chats.push(chat);
  metadata.chat ??= chat;
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
    const title = choice.chats.find((chat) => chat.provider === "codex" && chat.id === threadId)?.title;
    console.log(`Archived Codex chat: ${title || threadId}`);
  } catch (error) {
    process.stderr.write(`Warning: failed to archive Codex chat ${threadId}: ${commandFailureMessage(error)}\n`);
  }
}

function queryCodexCatalogRows(worktreePaths: string[], threadIds: string[]): CodexCatalogRow[] {
  const db = codexCatalogPath();
  if (!existsSync(db) || (worktreePaths.length === 0 && threadIds.length === 0)) {
    return [];
  }

  const filters: string[] = [];
  if (worktreePaths.length > 0) {
    filters.push(`cwd in (${worktreePaths.map(sqlQuote).join(", ")})`);
  }

  if (threadIds.length > 0) {
    filters.push(`thread_id in (${threadIds.map(sqlQuote).join(", ")})`);
  }

  const sql = `select display_title, thread_id, cwd, source_updated_at
from local_thread_catalog
where missing_candidate = 0
  and (${filters.join(" or ")})
order by source_updated_at desc;`;

  try {
    const output = execFileSync("sqlite3", ["-separator", "\t", db, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!output) {
      return [];
    }

    return output.split("\n").flatMap((line) => {
      const [title, threadId, cwd, updatedAt] = line.split("\t");
      return title || threadId || cwd
        ? [
            {
              provider: "codex",
              id: threadId ?? "",
              title: title ?? "",
              threadId: threadId ?? "",
              cwd: cwd ?? "",
              updatedAtMs: timestampMs(updatedAt),
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

function timestampMs(value: string | undefined): number | undefined {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }

  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

export function codexCatalogPath(): string {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sqlite", "codex-dev.db");
}

function readGitdirJsonValue(worktreePath: string, filename: string, key: string): string | null {
  const gitdir = gitdirForPath(worktreePath);
  if (!gitdir) {
    return null;
  }

  return readGitdirJsonValueFromGitdir(gitdir, filename, key);
}

function readGitdirJsonValueFromGitdir(gitdir: string, filename: string, key: string): string | null {
  const file = path.join(gitdir, filename);
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

function gitdirForPath(worktreePath: string): string | null {
  const dotGit = path.join(worktreePath, ".git");

  try {
    const stats = lstatSync(dotGit);
    if (stats.isDirectory()) {
      return dotGit;
    }

    if (stats.isSymbolicLink()) {
      const realPath = realpathSync(dotGit);
      const targetStats = statSync(realPath);
      if (targetStats.isDirectory()) {
        return realPath;
      }
    }

    if (stats.isFile() || stats.isSymbolicLink()) {
      const source = readFileSync(dotGit, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(source);
      if (!match) {
        return null;
      }

      const gitdir = match[1]!.trim();
      return path.isAbsolute(gitdir) ? gitdir : path.resolve(worktreePath, gitdir);
    }
  } catch {
    return null;
  }

  return null;
}

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
