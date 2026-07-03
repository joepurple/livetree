#!/usr/bin/env node

import { initWorktree } from "./commands/init.js";
import { listWorktrees } from "./commands/list.js";
import { goToWorktree } from "./commands/go.js";
import { completeSelectors, printCompletionScript } from "./commands/completion.js";
import { installTools } from "./commands/install.js";
import { removeWorktrees } from "./commands/remove.js";
import { runConfiguredScript } from "./commands/run.js";
import { runShellCommand, watchShellCommand } from "./commands/shell.js";
import { openWorktreeSwitcher, switchBySelector } from "./commands/switch.js";
import { CliError } from "./errors.js";
import { buildProjectContext } from "./worktrees.js";

const usage = `Usage:
  lt
  lt use [selector]
  lt switch [selector]
  lt @<selector>
  lt switcher [query]
  lt <script-name> [args...]
  lt list [query]
  lt ls [query]
  lt go [query]
  lt init
  lt run <script-name> [args...]
  lt watch <script-name> [args...]
  lt : <shell-command> [args...]
  lt run: <shell-command> [args...]
  lt watch: <shell-command> [args...]
  lt rm
  lt remove
  lt delete
  lt completion zsh
  lt install tools

Use 'lt switch <selector>' to select a worktree by branch name,
worktree directory name, commit prefix, path, Codex thread id prefix, or
Codex chat title fragment.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0 && ["-h", "--help", "help"].includes(args[0] ?? "")) {
    console.log(usage);
    return;
  }

  if (args[0] === "completion") {
    printCompletionScript(args[1] ?? "");
    return;
  }

  if (args[0] === "install") {
    installTools(args[1] ?? "");
    return;
  }

  if (args[0] === "__complete") {
    if (args[1] === "selectors") {
      try {
        const context = buildProjectContext(process.cwd());
        for (const candidate of completeSelectors(context, args[2] ?? "")) {
          console.log(candidate);
        }
      } catch {
        // Shell completion should fail closed rather than printing errors into the prompt.
      }
    }
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

  if (args[0] === "go") {
    await goToWorktree(context, args.slice(1).join(" "));
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

  if (args[0]?.startsWith("@")) {
    const selector = [args[0].slice(1), ...args.slice(1)].join(" ");
    await switchBySelector(context, selector);
    return;
  }

  if (["use", "switch"].includes(args[0] ?? "")) {
    await switchBySelector(context, args.slice(1).join(" "));
    return;
  }

  if (args[0] === "switcher") {
    await openWorktreeSwitcher(context, args.slice(1).join(" "));
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

  await openWorktreeSwitcher(context);
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
