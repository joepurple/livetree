import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePath } from "./path-utils.js";
import type { Chat } from "./types.js";

export type ClaudeMetadata = {
  chat: Chat | null;
  chats: Chat[];
};

type ClaudeSession = {
  customTitle: string | null;
  id: string;
  paths: Set<string>;
  slug: string | null;
  updatedAtMs: number;
};

type CachedClaudeSession = {
  modifiedAtMs: number;
  session: ClaudeSession | null;
  size: number;
};

type ClaudeEvent = {
  customTitle?: unknown;
  cwd?: unknown;
  isSidechain?: unknown;
  sessionId?: unknown;
  slug?: unknown;
  timestamp?: unknown;
  type?: unknown;
};

const sessionCache = new Map<string, CachedClaudeSession>();

export function claudeMetadataForPaths(worktreePaths: string[]): Map<string, ClaudeMetadata> {
  const metadata = new Map<string, ClaudeMetadata>(
    worktreePaths.map((worktreePath) => [worktreePath, { chat: null, chats: [] }]),
  );
  if (worktreePaths.length === 0) {
    return metadata;
  }

  const normalizedTargets = new Map(worktreePaths.map((worktreePath) => [normalizePath(worktreePath), worktreePath]));
  for (const transcript of claudeTranscriptPathsForWorktrees(worktreePaths)) {
    const session = readClaudeSession(transcript);
    if (!session) {
      continue;
    }

    const chat: Chat = {
      provider: "claude",
      id: session.id,
      title: session.customTitle || session.slug || session.id,
      updatedAtMs: session.updatedAtMs,
    };

    for (const normalizedPath of session.paths) {
      const worktreePath = normalizedTargets.get(normalizedPath);
      if (!worktreePath) {
        continue;
      }

      const entry = metadata.get(worktreePath);
      if (entry && !entry.chats.some((candidate) => candidate.id === chat.id)) {
        entry.chats.push(chat);
      }
    }
  }

  for (const entry of metadata.values()) {
    entry.chats.sort(newestChatFirst);
    entry.chat = entry.chats[0] ?? null;
  }

  return metadata;
}

export function claudeProjectsPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
}

export function claudeProjectDirectoriesForWorktrees(worktreePaths: string[]): string[] {
  const projects = claudeProjectsPath();
  if (!existsSync(projects)) {
    return [];
  }

  const encodedPaths = worktreePaths.map(encodeClaudeProjectPath);
  try {
    return readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && encodedPaths.some((encoded) => encoded === entry.name || encoded.startsWith(`${entry.name}-`)))
      .map((entry) => path.join(projects, entry.name));
  } catch {
    return [];
  }
}

export function claudeTranscriptPathsForWorktrees(worktreePaths: string[]): string[] {
  return claudeProjectDirectoriesForWorktrees(worktreePaths).flatMap((directory) => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => path.join(directory, entry.name));
    } catch {
      return [];
    }
  });
}

function readClaudeSession(transcript: string): ClaudeSession | null {
  let modifiedAtMs: number;
  let size: number;
  try {
    const stats = statSync(transcript);
    modifiedAtMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    return null;
  }

  const cached = sessionCache.get(transcript);
  if (cached && cached.modifiedAtMs === modifiedAtMs && cached.size === size) {
    return cached.session;
  }

  let source: string;
  try {
    source = readFileSync(transcript, "utf8");
  } catch {
    return null;
  }

  const fallbackId = path.basename(transcript, ".jsonl");
  const session: ClaudeSession = {
    customTitle: null,
    id: fallbackId,
    paths: new Set(),
    slug: null,
    updatedAtMs: modifiedAtMs,
  };

  for (const line of source.split("\n")) {
    if (!line || (!line.includes('"cwd"') && !line.includes('"customTitle"') && !line.includes('"slug"'))) {
      continue;
    }

    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      continue;
    }

    if (event.isSidechain === true) {
      continue;
    }

    if (typeof event.sessionId === "string" && event.sessionId) {
      session.id = event.sessionId;
    }
    if (typeof event.customTitle === "string" && event.customTitle) {
      session.customTitle = event.customTitle;
    }
    if (typeof event.slug === "string" && event.slug) {
      session.slug = event.slug;
    }
    if (typeof event.timestamp === "string") {
      const timestamp = Date.parse(event.timestamp);
      if (Number.isFinite(timestamp)) {
        session.updatedAtMs = Math.max(session.updatedAtMs, timestamp);
      }
    }
    if (typeof event.cwd === "string") {
      session.paths.add(normalizePath(event.cwd));
    }
  }

  sessionCache.set(transcript, { modifiedAtMs, session, size });
  return session;
}

function encodeClaudeProjectPath(value: string): string {
  return normalizePath(value).replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

function newestChatFirst(left: Chat, right: Chat): number {
  return (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0) || left.id.localeCompare(right.id);
}
