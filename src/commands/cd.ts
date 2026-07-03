import { spawnSync } from "node:child_process";
import { activeSource } from "../source.js";
import { formatChoiceList, selectFromInteractiveWorktreeBrowser } from "../ui.js";
import { worktreeListItemsModifiedNewestFirst } from "../worktrees.js";
import { CliError } from "../errors.js";
import { resolveSelector } from "./switch.js";
import type { ProjectContext, WorktreeChoice } from "../types.js";

type CdToWorktreeOptions = {
  writePasteboard?: (value: string) => void;
};

export async function cdToWorktree(context: ProjectContext, selectorInput = "", options: CdToWorktreeOptions = {}): Promise<void> {
  const selector = selectorInput.trim();
  const active = activeSource(context);
  const items = worktreeListItemsModifiedNewestFirst(context.choices);
  const target = selector ? resolveSelector(context, selector) : process.stdin.isTTY ? await selectFromInteractiveWorktreeBrowser({ active, items }) : resolveCdTarget(context);
  const command = `cd ${shellQuote(target.path)}`;
  const writePasteboard = options.writePasteboard ?? writeMacPasteboard;
  writePasteboard(command);
  process.stderr.write(`Copied to pasteboard: ${command}\n`);
}

function resolveCdTarget(context: ProjectContext): WorktreeChoice {
  if (context.choices.length === 1) {
    return context.choices[0]!;
  }

  if (context.choices.length === 0) {
    throw new CliError("No worktrees found.");
  }

  throw new CliError(`Choose a worktree with 'lt cd <selector>':\n${formatChoiceList(context.choices, activeSource(context))}`);
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
