import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePath } from "./path-utils.js";
import type { Chat } from "./types.js";

export type CursorMetadata = {
  chat: Chat | null;
  chats: Chat[];
};

type ComposerHeaderRow = {
  composerId?: unknown;
  workspaceId?: unknown;
  lastUpdatedAt?: unknown;
  value?: unknown;
};

type ComposerHead = {
  name?: unknown;
  subtitle?: unknown;
  workspaceIdentifier?: { uri?: { fsPath?: unknown } };
  agentLocation?: { environment?: { uri?: { fsPath?: unknown } } };
  trackedGitRepos?: Array<{ repoPath?: unknown }>;
};

export function cursorUserDir(): string {
  if (process.env.CURSOR_USER_DIR) {
    return process.env.CURSOR_USER_DIR;
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User");
  }

  return path.join(os.homedir(), ".config", "Cursor", "User");
}

export function cursorMetadataForPaths(worktreePaths: string[]): Map<string, CursorMetadata> {
  const metadata = new Map<string, CursorMetadata>(
    worktreePaths.map((worktreePath) => [worktreePath, { chat: null, chats: [] }]),
  );
  if (worktreePaths.length === 0) {
    return metadata;
  }

  const userDir = cursorUserDir();
  const database = path.join(userDir, "globalStorage", "state.vscdb");
  if (!existsSync(database)) {
    return metadata;
  }

  const normalizedTargets = new Map(worktreePaths.map((worktreePath) => [normalizePath(worktreePath), worktreePath]));
  const workspaceFolders = readWorkspaceFolders(userDir);

  for (const row of queryComposerHeaders(database)) {
    const composerId = typeof row.composerId === "string" ? row.composerId : "";
    if (!composerId || composerId === "empty-state-draft" || composerId.startsWith("tile-draft")) {
      continue;
    }

    const head = parseComposerHead(row.value);
    if (!head) {
      continue;
    }

    const title = scalarString(head.name) ?? scalarString(head.subtitle);
    if (!title) {
      continue;
    }

    const workspaceId = typeof row.workspaceId === "string" ? row.workspaceId : "";
    const chatPath = composerWorkspacePath(head) ?? workspaceFolders.get(workspaceId) ?? null;
    if (!chatPath) {
      continue;
    }

    const worktreePath = normalizedTargets.get(normalizePath(chatPath));
    if (!worktreePath) {
      continue;
    }

    const entry = metadata.get(worktreePath);
    if (!entry || entry.chats.some((chat) => chat.id === composerId)) {
      continue;
    }

    entry.chats.push({
      provider: "cursor",
      id: composerId,
      title,
      updatedAtMs: typeof row.lastUpdatedAt === "number" && row.lastUpdatedAt > 0 ? row.lastUpdatedAt : undefined,
    });
  }

  for (const entry of metadata.values()) {
    entry.chats.sort(newestChatFirst);
    entry.chat = entry.chats[0] ?? null;
  }

  return metadata;
}

function queryComposerHeaders(database: string): ComposerHeaderRow[] {
  let output: string;
  try {
    output = execFileSync(
      "sqlite3",
      ["-readonly", "-json", database, "select composerId, workspaceId, lastUpdatedAt, value from composerHeaders where isSubagent = 0;"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    ).trim();
  } catch {
    return [];
  }

  if (!output) {
    return [];
  }

  try {
    const rows = JSON.parse(output) as unknown;
    return Array.isArray(rows) ? (rows as ComposerHeaderRow[]) : [];
  } catch {
    return [];
  }
}

function parseComposerHead(value: unknown): ComposerHead | null {
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const head = JSON.parse(value) as unknown;
    return head && typeof head === "object" ? (head as ComposerHead) : null;
  } catch {
    return null;
  }
}

function composerWorkspacePath(head: ComposerHead): string | null {
  return (
    scalarString(head.workspaceIdentifier?.uri?.fsPath)
    ?? scalarString(head.agentLocation?.environment?.uri?.fsPath)
    ?? scalarString(Array.isArray(head.trackedGitRepos) ? head.trackedGitRepos[0]?.repoPath : null)
  );
}

function readWorkspaceFolders(userDir: string): Map<string, string> {
  const folders = new Map<string, string>();
  const workspaceStorage = path.join(userDir, "workspaceStorage");

  let entries: string[];
  try {
    entries = readdirSync(workspaceStorage);
  } catch {
    return folders;
  }

  for (const entry of entries) {
    try {
      const workspace = JSON.parse(readFileSync(path.join(workspaceStorage, entry, "workspace.json"), "utf8")) as { folder?: unknown };
      if (typeof workspace.folder !== "string" || !workspace.folder.startsWith("file://")) {
        continue;
      }

      folders.set(entry, decodeURIComponent(new URL(workspace.folder).pathname));
    } catch {
      continue;
    }
  }

  return folders;
}

function scalarString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function newestChatFirst(left: Chat, right: Chat): number {
  return (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0) || left.id.localeCompare(right.id);
}
