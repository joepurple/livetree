import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import path from "node:path";
import { claudeProjectDirectoriesForWorktrees, claudeProjectsPath } from "../claude.js";
import { codexCatalogPath } from "../codex.js";
import { CliError } from "../errors.js";
import { isDanglingSymlink, normalizePath, resolveExistingPath, samePath } from "../path-utils.js";
import { activeSource } from "../source.js";
import type { ProjectContext, WorktreeChoice } from "../types.js";
import { formatChoiceList, formatNumberedChoiceList, runInteractiveWorktreeSwitcher, selectFromInteractiveWorktreeList } from "../ui.js";
import type { WorktreeSwitcherSnapshot } from "../ui.js";
import { buildProjectContext, worktreeListItemsModifiedNewestFirst } from "../worktrees.js";

type SwitchSourceOptions = {
  quiet?: boolean;
};

type WatchTarget = {
  path: string;
  shouldRefresh: (eventType: string, filename: string | Buffer | null) => boolean;
};

export function resolveSelector(context: ProjectContext, selector: string): WorktreeChoice {
  const directPath = resolveExistingPath(selector, context.cwd);
  const lowerSelector = selector.toLowerCase();
  if (lowerSelector === "root") {
    const root = context.choices.find((choice) => choice.isMain) ?? context.choices.find((choice) => samePath(choice.path, context.mainRoot));
    if (root) {
      return root;
    }
  }

  const matches = context.choices.filter((choice) => {
    const branch = choice.branch ?? "";
    const head = choice.head ?? "";
    const basename = path.basename(choice.path);
    const chats = choice.chats.length > 0 ? choice.chats : choice.chat ? [choice.chat] : [];

    return (
      choice.path === selector ||
      normalizePath(choice.path) === normalizePath(selector) ||
      (directPath !== null && samePath(choice.path, directPath)) ||
      basename === selector ||
      branch === selector ||
      head.startsWith(selector) ||
      chats.some((chat) => chat.id.startsWith(selector) || chat.title.toLowerCase().includes(lowerSelector))
    );
  });

  if (matches.length === 1) {
    return matches[0]!;
  }

  if (matches.length > 1) {
    throw new CliError(`More than one worktree matched '${selector}':\n${formatChoiceList(matches, activeSource(context))}`);
  }

  throw new CliError(`No worktree matched '${selector}'.`);
}

export async function selectWorktree(context: ProjectContext): Promise<WorktreeChoice> {
  const active = activeSource(context);

  if (!process.stdin.isTTY) {
    throw new CliError(`Choose a worktree with 'lt use <selector>'. Available worktrees:\n${formatNumberedChoiceList(context.choices, active)}`);
  }

  const [selected] = await selectFromInteractiveWorktreeList({
    active,
    items: worktreeListItemsModifiedNewestFirst(context.choices),
    multiple: false,
  });
  if (!selected) {
    throw new CliError("No worktree selected.");
  }

  return selected;
}

export async function switchBySelector(context: ProjectContext, selector: string): Promise<void> {
  const trimmed = selector.trim();
  const target = trimmed ? resolveSelector(context, trimmed) : await selectWorktree(context);
  switchSource(context, target);
}

export function contextWithSelectedSource(context: ProjectContext, selector: string): ProjectContext {
  return {
    ...context,
    sourceOverride: resolveSelector(context, selector).path,
  };
}

export async function openWorktreeSwitcher(context: ProjectContext, initialQuery = ""): Promise<void> {
  const active = activeSource(context);

  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new CliError(`Open the switcher from an interactive terminal:\n${formatNumberedChoiceList(context.choices, active)}`);
  }

  await runInteractiveWorktreeSwitcher({
    active,
    initialQuery,
    items: worktreeListItemsModifiedNewestFirst(context.choices),
    onRefresh: (refresh) => watchWorktreeSwitcher(context, refresh),
    onSelect: (target) => {
      switchSource(context, target, { quiet: true });
    },
  });
}

function watchWorktreeSwitcher(context: ProjectContext, refresh: (snapshot: WorktreeSwitcherSnapshot) => void): () => void {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRefresh = (): void => {
    if (closed || refreshTimer) {
      return;
    }

    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (closed) {
        return;
      }

      try {
        refresh(loadWorktreeSwitcherSnapshot(context));
        syncWatchedPaths();
      } catch {
        // Git may briefly expose incomplete metadata while worktree commands are running.
      }
    }, 100);
  };

  const syncWatchedPaths = (): void => {
    for (const [targetPath, watcher] of watchers) {
      if (!existsSync(targetPath)) {
        watcher.close();
        watchers.delete(targetPath);
      }
    }

    for (const target of worktreeSwitcherWatchTargets(context)) {
      const targetPath = target.path;
      if (watchers.has(targetPath) || !existsSync(targetPath)) {
        continue;
      }

      try {
        const watcher = watch(targetPath, (eventType, filename) => {
          if (target.shouldRefresh(eventType, filename)) {
            scheduleRefresh();
          }
        });
        watcher.on("error", scheduleRefresh);
        watchers.set(targetPath, watcher);
      } catch {
        // Missing or platform-specific unwatchable paths can be skipped.
      }
    }
  };

  syncWatchedPaths();

  return () => {
    closed = true;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();
  };
}

function loadWorktreeSwitcherSnapshot(context: ProjectContext): WorktreeSwitcherSnapshot {
  const nextContext = buildProjectContext(context.mainRoot);
  return {
    active: activeSource(nextContext),
    items: worktreeListItemsModifiedNewestFirst(nextContext.choices),
  };
}

function worktreeSwitcherWatchTargets(context: ProjectContext): WatchTarget[] {
  const catalogPath = codexCatalogPath();
  const catalogName = path.basename(catalogPath);
  const anyEvent = (): boolean => true;
  const worktreesEntry = (eventType: string, filename: string | Buffer | null): boolean => eventType === "rename" && filenameText(filename) === "worktrees";
  const directoryEntryRenamed = (eventType: string): boolean => eventType === "rename";
  const catalogEntry = (eventType: string, filename: string | Buffer | null): boolean => eventType === "rename" && filenameText(filename) === catalogName;

  const worktreePaths = context.choices.map((choice) => choice.path);
  const claudeProjects = claudeProjectsPath();
  return [
    { path: context.commonDir, shouldRefresh: worktreesEntry },
    { path: path.join(context.commonDir, "worktrees"), shouldRefresh: directoryEntryRenamed },
    { path: context.liveDir, shouldRefresh: anyEvent },
    { path: path.dirname(catalogPath), shouldRefresh: catalogEntry },
    { path: catalogPath, shouldRefresh: anyEvent },
    { path: claudeProjects, shouldRefresh: directoryEntryRenamed },
    ...claudeProjectDirectoriesForWorktrees(worktreePaths).map((targetPath) => ({ path: targetPath, shouldRefresh: anyEvent })),
  ];
}

function filenameText(filename: string | Buffer | null): string | null {
  return typeof filename === "string" ? filename : filename?.toString() ?? null;
}

export function switchSource(context: ProjectContext, target: WorktreeChoice, options: SwitchSourceOptions = {}): void {
  mkdirSync(context.liveDir, { recursive: true });

  if (existsSync(context.srcLink) && !lstatSync(context.srcLink).isSymbolicLink()) {
    throw new CliError(`Refusing to replace non-symlink path: ${context.srcLink}`);
  }

  if (existsSync(context.srcLink) || isDanglingSymlink(context.srcLink)) {
    unlinkSync(context.srcLink);
  }

  symlinkSync(target.path, context.srcLink, "dir");
  writeFileSync(context.stateFile, `${target.path}\n`, "utf8");

  if (!options.quiet) {
    console.log(`.livetree/src -> ${target.path}`);
    console.log(`Active: ${target.label}`);
  }
}
