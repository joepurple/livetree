import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePath } from "./path-utils.js";
import type { Chat } from "./types.js";

export type T3Metadata = {
  chat: Chat | null;
  chats: Chat[];
};

type T3ThreadRow = {
  thread_id?: unknown;
  title?: unknown;
  worktree_path?: unknown;
  updated_at?: unknown;
  provider_name?: unknown;
};

export function t3MetadataForPaths(worktreePaths: string[]): Map<string, T3Metadata> {
  const metadata = new Map<string, T3Metadata>(
    worktreePaths.map((worktreePath) => [worktreePath, { chat: null, chats: [] }]),
  );
  if (worktreePaths.length === 0) {
    return metadata;
  }

  const normalizedTargets = new Map(worktreePaths.map((worktreePath) => [normalizePath(worktreePath), worktreePath]));
  for (const row of queryT3Threads(worktreePaths)) {
    const id = scalarString(row.thread_id);
    const title = scalarString(row.title);
    const worktreePath = scalarString(row.worktree_path);
    const provider = chatProvider(row.provider_name);
    if (!id || !title || !worktreePath || !provider) {
      continue;
    }

    const targetPath = normalizedTargets.get(normalizePath(worktreePath));
    const entry = targetPath ? metadata.get(targetPath) : undefined;
    if (!entry || entry.chats.some((chat) => chat.id === id)) {
      continue;
    }

    entry.chats.push({
      provider,
      id,
      title,
      updatedAtMs: timestampMs(row.updated_at),
    });
  }

  for (const entry of metadata.values()) {
    entry.chats.sort(newestChatFirst);
    entry.chat = entry.chats[0] ?? null;
  }

  return metadata;
}

export function t3StatePath(): string {
  return process.env.T3_STATE_DB ?? path.join(os.homedir(), ".t3", "userdata", "state.sqlite");
}

function queryT3Threads(worktreePaths: string[]): T3ThreadRow[] {
  const database = t3StatePath();
  if (!existsSync(database)) {
    return [];
  }

  const sql = `select
  threads.thread_id,
  threads.title,
  threads.worktree_path,
  coalesce(threads.updated_at, threads.latest_user_message_at, threads.created_at) as updated_at,
  sessions.provider_name
from projection_threads as threads
left join projection_thread_sessions as sessions on sessions.thread_id = threads.thread_id
where threads.deleted_at is null
  and threads.worktree_path in (${worktreePaths.map(sqlQuote).join(", ")})
order by
  coalesce(threads.updated_at, threads.latest_user_message_at, threads.created_at) desc,
  threads.created_at desc,
  threads.thread_id;`;

  let output: string;
  try {
    output = execFileSync("sqlite3", ["-readonly", "-json", database, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch {
    return [];
  }

  if (!output) {
    return [];
  }

  try {
    const rows = JSON.parse(output) as unknown;
    return Array.isArray(rows) ? (rows as T3ThreadRow[]) : [];
  } catch {
    return [];
  }
}

function chatProvider(value: unknown): Chat["provider"] | null {
  if (typeof value !== "string") {
    return null;
  }

  const provider = value.toLowerCase();
  if (provider.startsWith("claude")) return "claude";
  if (provider.startsWith("codex")) return "codex";
  if (provider.startsWith("cursor")) return "cursor";
  return null;
}

function scalarString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    return normalizedTimestampMs(value);
  }

  if (typeof value !== "string" || !value) {
    return undefined;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return normalizedTimestampMs(numeric);
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizedTimestampMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function newestChatFirst(left: Chat, right: Chat): number {
  return (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0) || left.id.localeCompare(right.id);
}

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
