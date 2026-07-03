import { activeSource } from "../source.js";
import { filterWorktreeListItems, printWorktreeList, selectFromInteractiveWorktreeList } from "../ui.js";
import { worktreeListItemsModifiedNewestFirst } from "../worktrees.js";
import type { ProjectContext } from "../types.js";

export async function listWorktrees(context: ProjectContext, query = ""): Promise<void> {
  const active = activeSource(context);
  const items = worktreeListItemsModifiedNewestFirst(context.choices);

  if (process.stdin.isTTY) {
    await selectFromInteractiveWorktreeList({
      active,
      initialQuery: query,
      items,
      multiple: false,
    });
    return;
  }

  printWorktreeList(filterWorktreeListItems(items, query), active, query);
}
