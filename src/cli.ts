#!/usr/bin/env node

import { initWorktree } from "./commands/init.js";
import { listWorktrees } from "./commands/list.js";
import { removeWorktrees } from "./commands/remove.js";
import { runConfiguredScript } from "./commands/run.js";
import { runShellCommand, watchShellCommand } from "./commands/shell.js";
import { resolveSelector, selectWorktree, switchSource } from "./commands/switch.js";
import { CliError } from "./errors.js";
import { buildProjectContext } from "./worktrees.js";

const usage = `Usage:
  lt
  lt use [selector]
  lt switch [selector]
  lt <script-name> [args...]
  lt list [query]
  lt ls [query]
  lt init
  lt run <script-name> [args...]
  lt watch <script-name> [args...]
  lt : <shell-command> [args...]
  lt run: <shell-command> [args...]
  lt watch: <shell-command> [args...]
  lt rm
  lt remove
  lt delete

Use 'lt switch <selector>' to select a worktree by branch name,
worktree directory name, commit prefix, path, Codex thread id prefix, or
Codex chat title fragment.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0 && ["-h", "--help", "help"].includes(args[0] ?? "")) {
    console.log(usage);
    return;
  }

  const context = buildProjectContext(process.cwd());
  if (context.choices.length === 0) {
    throw new CliError("No worktrees found for this project.");
  }

  if (args[0] === "init") {
    if (args.length > 1) {
      throw new CliError("Usage: lt init");
    }

    await initWorktree(context);
    return;
  }

  if (["list", "ls"].includes(args[0] ?? "")) {
    await listWorktrees(context, args.slice(1).join(" "));
    return;
  }

  if (args[0] === "run") {
    await runConfiguredScript(context, args.slice(1), false);
    return;
  }

  if (args[0] === "watch") {
    await runConfiguredScript(context, args.slice(1), true);
    return;
  }

  if ([":", "run:"].includes(args[0] ?? "")) {
    runShellCommand(context, args.slice(1), args[0]);
    return;
  }

  if (args[0] === "watch:") {
    await watchShellCommand(context, args.slice(1));
    return;
  }

  if (["use", "switch"].includes(args[0] ?? "")) {
    const selector = args.slice(1).join(" ").trim();
    const target = selector ? resolveSelector(context, selector) : await selectWorktree(context);
    switchSource(context, target);
    return;
  }

  if (["rm", "remove", "delete"].includes(args[0] ?? "")) {
    if (args.length > 1) {
      throw new CliError("Usage: lt rm");
    }

    await removeWorktrees(context);
    return;
  }

  if (args.length > 0) {
    await runConfiguredScript(context, args, false, { shortcut: true });
    return;
  }

  const target = await selectWorktree(context);
  switchSource(context, target);
}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    if (error.message !== "Canceled.") {
      console.error(error.message);
    }
    process.exit(error.exitCode);
  }

  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
