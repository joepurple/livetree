import { activeSource } from "../source.js";
import { browseInteractiveWorktreeList, filterWorktreeListItems, printWorktreeList } from "../ui.js";
import { worktreeListItemsModifiedNewestFirst } from "../worktrees.js";
import type { ProjectContext } from "../types.js";

export async function listWorktrees(context: ProjectContext, query = ""): Promise<void> {
  const active = activeSource(context);
  const items = worktreeListItemsModifiedNewestFirst(context.choices);

  if (process.stdin.isTTY) {
    await browseInteractiveWorktreeList({
      active,
      initialQuery: query,
      items,
    });
    return;
  }

  printWorktreeList(filterWorktreeListItems(items, query), active, query);
}
