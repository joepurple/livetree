import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { codexMetadataForPaths } from "./codex.js";
import { CliError } from "./errors.js";
import { git, gitCommonDir, parseWorktreeList } from "./git.js";
import { firstPositiveNumber, maxPositiveNumber, pathModifiedAtMs } from "./path-utils.js";
import type { CreatedWorktreeChoice, ModifiedWorktreeChoice, ProjectContext, WorktreeChoice, WorktreeListItem, WorktreeRecord } from "./types.js";

type BuildProjectContextOptions = {
  loadChoices?: boolean;
};

type WorktreeMetadata = {
  chat: WorktreeChoice["chat"];
  chats: WorktreeChoice["chats"];
  lastCommitAtMs: number | null;
  syncedBranch: string | null;
};

export function buildProjectContext(cwd: string, options: BuildProjectContextOptions = {}): ProjectContext {
  const currentRoot = git(["rev-parse", "--show-toplevel"], cwd, "lt must be run inside a Git worktree.");
  const commonDir = gitCommonDir(currentRoot);
  const records = parseWorktreeList(git(["--git-dir", commonDir, "worktree", "list", "--porcelain"], currentRoot));
  const worktrees = records.filter((record) => !record.bare);
  const mainRoot = worktrees[0]?.path;

  if (!mainRoot) {
    throw new CliError("No non-bare worktrees found for this project.");
  }

  const liveDir = path.join(mainRoot, ".livetree");
  const srcLink = path.join(liveDir, "src");
  const stateFile = path.join(liveDir, ".source");
  const choices = options.loadChoices === false ? [] : enrichWorktrees(worktrees, commonDir, currentRoot);

  return {
    cwd,
    currentRoot,
    commonDir,
    mainRoot,
    liveDir,
    srcLink,
    stateFile,
    choices,
  };
}

export function buildFastProjectContext(cwd: string): ProjectContext {
  return buildProjectContext(cwd, { loadChoices: false });
}

export function worktreeListItemsModifiedNewestFirst(choices: WorktreeChoice[]): WorktreeListItem[] {
  return worktreesModifiedNewestFirst(choices).map((item) => ({
    ...item,
    searchText: worktreeSearchText(item.choice),
  }));
}

export function worktreesModifiedNewestFirst(choices: WorktreeChoice[]): ModifiedWorktreeChoice[] {
  return choices
    .map((choice) => ({ choice, modifiedAtMs: worktreeModifiedAtMs(choice) }))
    .sort((left, right) => {
      if (right.modifiedAtMs !== left.modifiedAtMs) {
        return right.modifiedAtMs - left.modifiedAtMs;
      }

      return left.choice.path.localeCompare(right.choice.path);
    });
}

export function uninitializedWorktreesNewestFirst(choices: WorktreeChoice[]): WorktreeChoice[] {
  return worktreesNewestFirst(choices)
    .map((choice) => choice.choice)
    .filter((choice) => !isWorktreeInitialized(choice));
}

export function isWorktreeInitialized(choice: WorktreeChoice): boolean {
  const liveDir = path.join(choice.path, ".livetree");
  try {
    const stats = lstatSync(liveDir);
    if (stats.isDirectory()) {
      return true;
    }

    throw new CliError(`Cannot initialize worktree because .livetree exists and is not a directory: ${liveDir}`);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    return false;
  }
}

export function markWorktreeInitialized(choice: WorktreeChoice): void {
  const liveDir = path.join(choice.path, ".livetree");
  if (existsSync(liveDir) && !lstatSync(liveDir).isDirectory()) {
    throw new CliError(`Cannot mark worktree initialized because .livetree is not a directory: ${liveDir}`);
  }

  mkdirSync(liveDir, { recursive: true });
  writeFileSync(path.join(liveDir, ".source"), `${choice.path}\n`, "utf8");
}

function enrichWorktrees(records: WorktreeRecord[], commonDir: string, cwd: string): WorktreeChoice[] {
  const codexMetadata = codexMetadataForPaths(records.map((record) => record.path));
  const commitTimes = worktreeLastCommitTimesByHead(records, commonDir, cwd);

  return records.map((record, index) => {
    const metadata = codexMetadata.get(record.path);
    return enrichWorktree(record, index === 0, {
      chat: metadata?.chat ?? null,
      chats: metadata?.chats ?? [],
      syncedBranch: metadata?.syncedBranch ?? null,
      lastCommitAtMs: record.head ? (commitTimes.get(record.head) ?? null) : null,
    });
  });
}

function enrichWorktree(record: WorktreeRecord, isMain: boolean, metadata: WorktreeMetadata): WorktreeChoice {
  if (isMain) {
    const ref = refForWorktree(record, metadata);
    return {
      ...record,
      isMain,
      chat: null,
      chats: [],
      ref,
      lastCommitAtMs: metadata.lastCommitAtMs,
      label: ref ? `ROOT [${ref}]` : "ROOT",
    };
  }

  const chat = metadata.chat;
  const chatTitle = chat?.title ? `${chat.title}${extraChatCountLabel(metadata.chats)}` : null;
  const ref = refForWorktree(record, metadata);
  let label: string;

  if (chatTitle && ref) {
    label = `${chatTitle} [${ref}]`;
  } else if (chatTitle) {
    label = chatTitle;
  } else if (ref) {
    label = `[${ref}]`;
  } else {
    label = path.basename(record.path);
  }

  return {
    ...record,
    isMain,
    chat,
    chats: metadata.chats,
    ref,
    lastCommitAtMs: metadata.lastCommitAtMs,
    label,
  };
}

function extraChatCountLabel(chats: WorktreeChoice["chats"]): string {
  return chats.length > 1 ? ` (+${chats.length - 1})` : "";
}

function refForWorktree(record: WorktreeRecord, metadata: Pick<WorktreeMetadata, "syncedBranch">): string | null {
  if (record.branch) {
    return record.branch;
  }

  if (metadata.syncedBranch) {
    return metadata.syncedBranch;
  }

  if (record.head && !/^0+$/.test(record.head)) {
    return `detached:${record.head.slice(0, 12)}`;
  }

  return null;
}

function worktreeModifiedAtMs(choice: WorktreeChoice): number {
  const rootModifiedAt = pathModifiedAtMs(choice.path);
  const dirtyModifiedAt = worktreeDirtyModifiedAtMs(choice.path);
  const commitModifiedAt = choice.lastCommitAtMs ?? worktreeLastCommitAtMs(choice.path);
  return maxPositiveNumber(rootModifiedAt, dirtyModifiedAt, commitModifiedAt) ?? Number.NEGATIVE_INFINITY;
}

function worktreeDirtyModifiedAtMs(worktreePath: string): number | null {
  let output: string;
  try {
    output = execFileSync("git", ["-C", worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }

  const modifiedTimes = parsePorcelainPaths(output)
    .map((relativePath) => pathModifiedAtMs(path.join(worktreePath, relativePath)))
    .filter((value): value is number => value !== null);

  return maxPositiveNumber(...modifiedTimes);
}

function parsePorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  const records = output.split("\0").filter(Boolean);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) {
      continue;
    }

    const status = record.slice(0, 2);
    const firstPath = record.slice(3);
    if (firstPath) {
      paths.push(firstPath);
    }

    if (status.includes("R") || status.includes("C")) {
      const secondPath = records[index + 1];
      if (secondPath) {
        paths.push(secondPath);
        index += 1;
      }
    }
  }

  return paths;
}

function worktreeLastCommitTimesByHead(records: WorktreeRecord[], commonDir: string, cwd: string): Map<string, number> {
  const heads = [...new Set(records.map((record) => record.head).filter((head): head is string => typeof head === "string" && !/^0+$/.test(head)))];
  const times = new Map<string, number>();
  if (heads.length === 0) {
    return times;
  }

  let output: string;
  try {
    output = execFileSync("git", ["--git-dir", commonDir, "show", "-s", "--format=%H%x00%ct", ...heads], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return times;
  }

  for (const line of output.split("\n")) {
    const [head, secondsText] = line.split("\0");
    const seconds = Number.parseInt(secondsText ?? "", 10);
    if (head && Number.isFinite(seconds)) {
      times.set(head, seconds * 1000);
    }
  }

  return times;
}

function worktreeLastCommitAtMs(worktreePath: string): number | null {
  let output: string;
  try {
    output = execFileSync("git", ["-C", worktreePath, "log", "-1", "--format=%ct"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }

  const seconds = Number.parseInt(output, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function worktreesNewestFirst(choices: WorktreeChoice[]): CreatedWorktreeChoice[] {
  return choices
    .map((choice) => ({ choice, createdAtMs: worktreeCreatedAtMs(choice) }))
    .sort((left, right) => {
      if (right.createdAtMs !== left.createdAtMs) {
        return right.createdAtMs - left.createdAtMs;
      }

      return left.choice.path.localeCompare(right.choice.path);
    });
}

function worktreeCreatedAtMs(choice: WorktreeChoice): number {
  try {
    const stats = lstatSync(choice.path);
    return firstPositiveNumber(stats.birthtimeMs, stats.ctimeMs, stats.mtimeMs) ?? Number.NEGATIVE_INFINITY;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

function worktreeSearchText(choice: WorktreeChoice): string {
  return [
    choice.label,
    choice.path,
    path.basename(choice.path),
    choice.ref,
    choice.branch,
    choice.head,
    ...choice.chats.flatMap((chat) => [chat.title, chat.threadId]),
  ].filter((value): value is string => Boolean(value)).join(" ");
}
