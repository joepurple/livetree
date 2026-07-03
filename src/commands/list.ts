import { activeSource } from "../source.js";
import { CliError } from "../errors.js";
import { printWorktreeList } from "../ui.js";
import { worktreeListItemsModifiedNewestFirst } from "../worktrees.js";
import type { ProjectContext } from "../types.js";

export async function listWorktrees(context: ProjectContext, extraArgs = ""): Promise<void> {
  if (extraArgs.trim()) {
    throw new CliError("Usage: lt ls");
  }

  const active = activeSource(context);
  const items = worktreeListItemsModifiedNewestFirst(context.choices);
  printWorktreeList(items, active);
}
