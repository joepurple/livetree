import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "../errors.js";
import { isDanglingSymlink, normalizePath, resolveExistingPath, samePath } from "../path-utils.js";
import { activeSource } from "../source.js";
import type { ProjectContext, WorktreeChoice } from "../types.js";
import { formatChoiceList, formatNumberedChoiceList, runInteractiveWorktreeSwitcher, selectFromInteractiveWorktreeList } from "../ui.js";
import { worktreeListItemsModifiedNewestFirst } from "../worktrees.js";

type SwitchSourceOptions = {
  quiet?: boolean;
};

export function resolveSelector(context: ProjectContext, selector: string): WorktreeChoice {
  const directPath = resolveExistingPath(selector, context.cwd);
  const lowerSelector = selector.toLowerCase();
  const matches = context.choices.filter((choice) => {
    const branch = choice.branch ?? "";
    const head = choice.head ?? "";
    const basename = path.basename(choice.path);
    const title = choice.chat?.title.toLowerCase() ?? "";
    const threadId = choice.chat?.threadId ?? "";

    return (
      choice.path === selector ||
      normalizePath(choice.path) === normalizePath(selector) ||
      (directPath !== null && samePath(choice.path, directPath)) ||
      basename === selector ||
      branch === selector ||
      head.startsWith(selector) ||
      threadId.startsWith(selector) ||
      title.includes(lowerSelector)
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
    throw new CliError(`Choose a worktree with 'lt switch <selector>'. Available worktrees:\n${formatNumberedChoiceList(context.choices, active)}`);
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

export async function openWorktreeSwitcher(context: ProjectContext, initialQuery = ""): Promise<void> {
  const active = activeSource(context);

  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new CliError(`Open the switcher from an interactive terminal:\n${formatNumberedChoiceList(context.choices, active)}`);
  }

  await runInteractiveWorktreeSwitcher({
    active,
    initialQuery,
    items: worktreeListItemsModifiedNewestFirst(context.choices),
    onSelect: (target) => {
      switchSource(context, target, { quiet: true });
    },
  });
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
