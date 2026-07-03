import { spawnSync } from "node:child_process";
import { activeSource } from "../source.js";
import { filterWorktreeListItems, formatChoiceList, selectFromInteractiveWorktreeBrowser } from "../ui.js";
import { worktreeListItemsModifiedNewestFirst } from "../worktrees.js";
import { CliError } from "../errors.js";
import type { ProjectContext, WorktreeChoice } from "../types.js";

type GoToWorktreeOptions = {
  writePasteboard?: (value: string) => void;
};

export async function cdToWorktree(context: ProjectContext, query = "", options: GoToWorktreeOptions = {}): Promise<void> {
  const active = activeSource(context);
  const items = worktreeListItemsModifiedNewestFirst(context.choices);
  const target = process.stdin.isTTY ? await selectFromInteractiveWorktreeBrowser({ active, initialQuery: query, items }) : resolveGoTarget(context, query);
  const command = `cd ${shellQuote(target.path)}`;
  const writePasteboard = options.writePasteboard ?? writeMacPasteboard;
  writePasteboard(command);
  process.stderr.write(`Copied to pasteboard: ${command}\n`);
}

function resolveGoTarget(context: ProjectContext, query: string): WorktreeChoice {
  const items = filterWorktreeListItems(worktreeListItemsModifiedNewestFirst(context.choices), query);

  if (items.length === 1) {
    return items[0]!.choice;
  }

  if (items.length === 0) {
    throw new CliError(`No worktrees matched '${query.trim()}'.`);
  }

  throw new CliError(`More than one worktree matched '${query.trim()}':\n${formatChoiceList(items.map((item) => item.choice), activeSource(context))}`);
}

function writeMacPasteboard(value: string): void {
  const result = spawnSync("pbcopy", {
    input: value,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "pipe"],
  });

  if (result.error) {
    throw new CliError(`Failed to copy to pasteboard: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new CliError(detail ? `Failed to copy to pasteboard: ${detail}` : "Failed to copy to pasteboard.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
