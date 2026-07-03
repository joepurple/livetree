#!/usr/bin/env node

import { initWorktree } from "./commands/init.js";
import { listWorktrees } from "./commands/list.js";
import { cdToWorktree } from "./commands/cd.js";
import { completeSelectors } from "./commands/completion.js";
import { installTools } from "./commands/install.js";
import { removeWorktrees } from "./commands/remove.js";
import { runConfiguredScript } from "./commands/run.js";
import { runShellCommand, watchShellCommand } from "./commands/shell.js";
import { contextWithSelectedSource, openWorktreeSwitcher, switchBySelector } from "./commands/switch.js";
import { CliError } from "./errors.js";
import { buildFastProjectContext, buildProjectContext } from "./worktrees.js";

const usage = `Usage:
  lt
  lt use [selector]
  lt @<selector>
  lt <script-name> [args...]
  lt ls
  lt cd [selector]
  lt init
  lt run <script-name> [args...]
  lt watch <script-name> [args...]
  lt : <shell-command> [args...]
  lt run: <shell-command> [args...]
  lt watch: <shell-command> [args...]
  lt rm
  lt install tools

Use 'lt use <selector>' to select a worktree by branch name,
worktree directory name, commit prefix, path, Codex thread id prefix, or
Codex chat title fragment.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0 && ["-h", "--help", "help"].includes(args[0] ?? "")) {
    console.log(usage);
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

  const needsChoices = commandNeedsChoices(args);
  const context = needsChoices ? buildProjectContext(process.cwd()) : buildFastProjectContext(process.cwd());
  if (needsChoices && context.choices.length === 0) {
    throw new CliError("No worktrees found for this project.");
  }

  await runProjectCommand(context, args);
}

async function runProjectCommand(context: ReturnType<typeof buildProjectContext>, args: string[]): Promise<void> {
  if (args[0] === "init") {
    if (args.length > 1) {
      throw new CliError("Usage: lt init");
    }

    await initWorktree(context);
    return;
  }

  if (args[0] === "ls") {
    await listWorktrees(context, args.slice(1).join(" "));
    return;
  }

  if (args[0] === "cd") {
    await cdToWorktree(context, args.slice(1).join(" "));
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
    const selectorParts = args[0].length > 1 ? [args[0].slice(1)] : [];
    const restStart = selectorParts.length > 0 ? 1 : 2;
    if (selectorParts.length === 0 && args[1]) {
      selectorParts.push(args[1]);
    }

    const selector = selectorParts.join(" ");
    const rest = args.slice(restStart);
    if (rest.length === 0) {
      await switchBySelector(context, selector);
      return;
    }

    await runProjectCommand(contextWithSelectedSource(context, selector), rest);
    return;
  }

  if (args[0] === "use") {
    await switchBySelector(context, args.slice(1).join(" "));
    return;
  }

  if (args[0] === "rm") {
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

function commandNeedsChoices(args: string[]): boolean {
  const command = args[0] ?? "";
  return args.length === 0 || ["init", "ls", "cd", "rm", "use"].includes(command) || command.startsWith("@");
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
