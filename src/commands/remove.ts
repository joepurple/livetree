import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { archiveRemovedCodexChat, codexThreadIdForChoice } from "../codex.js";
import { CliError, WorktreeRemoveNeedsForceError, WorktreeRemovePrunableError } from "../errors.js";
import { formatGitFailure } from "../git.js";
import { activeSource, clearRemovedActiveSources } from "../source.js";
import { confirmYesNo } from "../terminal.js";
import type { ProjectContext, WorktreeChoice } from "../types.js";
import { ageColumnWidth, formatNumberedChoiceList, formatWorktreeListRow, selectFromInteractiveWorktreeList } from "../ui.js";
import { worktreeListItemsModifiedNewestFirst } from "../worktrees.js";

export async function removeWorktrees(context: ProjectContext): Promise<void> {
  const candidates = context.choices.filter((choice) => !choice.isMain);
  const active = activeSource(context);

  if (candidates.length === 0) {
    throw new CliError("No removable worktrees found. ROOT cannot be removed by lt.");
  }

  if (!process.stdin.isTTY) {
    throw new CliError(`Choose worktrees to remove from an interactive terminal:\n${formatNumberedChoiceList(candidates, active)}`);
  }

  const selected = await selectWorktreesToRemove(candidates, active);
  if (selected.length === 0) {
    throw new CliError("No worktrees selected.");
  }

  const confirmed = await confirmRemoveWorktrees(selected, active);
  if (!confirmed) {
    throw new CliError("Canceled.");
  }

  const removed: WorktreeChoice[] = [];
  for (const choice of selected) {
    const threadId = codexThreadIdForChoice(choice);
    const didRemove = await removeGitWorktreeWithForcePrompt(context, choice);
    if (didRemove) {
      removed.push(choice);
      console.log(`Removed: ${choice.label}`);
      archiveRemovedCodexChat(choice, threadId);
    }
  }

  const clearedSources = clearRemovedActiveSources(context, removed);
  for (const sourceName of clearedSources) {
    console.log(`Cleared ${sourceName} because it pointed at a removed worktree.`);
  }
}

async function selectWorktreesToRemove(choices: WorktreeChoice[], active: string | null): Promise<WorktreeChoice[]> {
  return selectFromInteractiveWorktreeList({
    active,
    items: worktreeListItemsModifiedNewestFirst(choices),
    multiple: true,
  });
}

async function confirmRemoveWorktrees(choices: WorktreeChoice[], active: string | null): Promise<boolean> {
  process.stderr.write("\nThe following worktrees will be removed:\n");
  const items = worktreeListItemsModifiedNewestFirst(choices);
  const ageWidth = ageColumnWidth(items);
  for (const item of items) {
    process.stderr.write(`  ${formatWorktreeListRow(item, active, ageWidth)}\n`);
    process.stderr.write(`    ${item.choice.path}\n`);
  }

  return confirmYesNo(`\nRemove ${choices.length} worktree${choices.length === 1 ? "" : "s"}? [y/n] `);
}

async function confirmForceRemoveWorktree(choice: WorktreeChoice): Promise<boolean> {
  return confirmYesNo(`Force remove ${choice.label} and delete all changes in that worktree? [y/n] `);
}

async function confirmDeletePrunableWorktreeDirectory(choice: WorktreeChoice): Promise<boolean> {
  return confirmYesNo(`Delete leftover directory for ${choice.label}? [y/n] `);
}

async function removeGitWorktreeWithForcePrompt(context: ProjectContext, choice: WorktreeChoice): Promise<boolean> {
  try {
    if (choice.prunable) {
      throw new WorktreeRemovePrunableError(`Git marks ${choice.label} as prunable: ${choice.prunable}`);
    }

    removeGitWorktree(context, choice, false);
    return true;
  } catch (error) {
    if (error instanceof WorktreeRemovePrunableError) {
      return removePrunableWorktree(context, choice, error.message);
    }

    if (!(error instanceof WorktreeRemoveNeedsForceError)) {
      throw error;
    }

    process.stderr.write(`${error.message}\n`);
    const confirmed = await confirmForceRemoveWorktree(choice);
    if (!confirmed) {
      console.log(`Skipped: ${choice.label}`);
      return false;
    }

    removeGitWorktree(context, choice, true);
    return true;
  }
}

async function removePrunableWorktree(context: ProjectContext, choice: WorktreeChoice, reason: string): Promise<boolean> {
  process.stderr.write(`${reason}\n`);
  pruneGitWorktrees(context);

  if (!existsSync(choice.path)) {
    console.log(`Pruned stale worktree metadata: ${choice.label}`);
    return true;
  }

  const gitFile = path.join(choice.path, ".git");
  if (existsSync(gitFile)) {
    console.log(`Pruned stale worktree metadata: ${choice.label}`);
    console.log(`Left directory in place because it now contains a .git file: ${choice.path}`);
    return true;
  }

  const confirmed = await confirmDeletePrunableWorktreeDirectory(choice);
  if (!confirmed) {
    console.log(`Pruned stale worktree metadata: ${choice.label}`);
    console.log(`Left directory in place: ${choice.path}`);
    return true;
  }

  rmSync(choice.path, { recursive: true, force: true });
  console.log(`Deleted leftover directory: ${choice.path}`);
  return true;
}

function pruneGitWorktrees(context: ProjectContext): void {
  try {
    execFileSync("git", ["worktree", "prune", "--expire", "now"], {
      cwd: context.mainRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new CliError(formatGitFailure(error, "git worktree prune --expire now"));
  }
}

function removeGitWorktree(context: ProjectContext, choice: WorktreeChoice, force: boolean): void {
  const args = force ? ["worktree", "remove", "--force", choice.path] : ["worktree", "remove", choice.path];
  try {
    execFileSync("git", args, {
      cwd: context.mainRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = formatGitFailure(error, `git ${args.join(" ")}`);
    if (!force && isWorktreeNeedsForceError(error)) {
      throw new WorktreeRemoveNeedsForceError(message);
    }

    if (!force && isWorktreePrunableError(error)) {
      throw new WorktreeRemovePrunableError(message);
    }

    throw new CliError(message);
  }
}

function isWorktreeNeedsForceError(error: unknown): boolean {
  const output = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
  return output.includes("contains modified or untracked files") && output.includes("--force");
}

function isWorktreePrunableError(error: unknown): boolean {
  const output = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
  return output.includes("validation failed, cannot remove working tree") && output.includes(".git") && output.includes("does not exist");
}
