#!/usr/bin/env node

import { runDevScript } from "./commands/dev.js";
import { initWorktree } from "./commands/init.js";
import { listWorktrees } from "./commands/list.js";
import { reportBackgroundServeError, resolveServeContext, runServerStartCommand, runServerStopCommand } from "./commands/serve.js";
import { runTunnelCommand } from "./commands/tunnel.js";
import { CliError } from "./errors.js";
import { isConfiguredProject, registerProject } from "./projects.js";
import { buildFastProjectContext, buildProjectContext } from "./worktrees.js";

const usage = `Usage:
  livetree init
  livetree ls
  livetree dev <script> [args...]
  livetree tunnel <script>
  livetree tunnel stop [<script>|all]
  livetree server start [--foreground] [--tailscale|--no-tailscale] [--port <number>]
  livetree server stop
  livetree <script> [args...]

Configuration is read from .ltconf in the main worktree.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (["-h", "--help", "help"].includes(args[0] ?? "")) {
    console.log(usage);
    return;
  }

  if (args.length === 0) {
    throw new CliError(usage);
  }

  const command = args[0]!;
  if (command === "server") {
    const action = args[1];
    if (action === "stop") {
      await runServerStopCommand(args.slice(2));
      return;
    }
    if (action !== "start") {
      throw new CliError("Usage: livetree server start [options] | livetree server stop");
    }
    const context = resolveServeContext(process.cwd());
    if (context && isConfiguredProject(context.mainRoot)) registerProject(context.mainRoot);
    await runServerStartCommand(context, args.slice(2));
    return;
  }

  const context = ["init", "ls"].includes(command)
    ? buildProjectContext(process.cwd())
    : buildFastProjectContext(process.cwd());

  if (isConfiguredProject(context.mainRoot)) {
    registerProject(context.mainRoot);
  }

  if (command === "init") {
    if (args.length > 1) throw new CliError("Usage: livetree init");
    await initWorktree(context);
  } else if (command === "ls") {
    await listWorktrees(context, args.slice(1).join(" "));
  } else if (command === "dev") {
    await runDevScript(context, args.slice(1));
  } else if (command === "tunnel") {
    await runTunnelCommand(context, args.slice(1));
  } else {
    await runDevScript(context, args, { shortcut: true });
  }
}

main().catch(async (error: unknown) => {
  const reportedToParent = await reportBackgroundServeError(error);
  if (error instanceof CliError) {
    if (!reportedToParent && error.message !== "Canceled.") console.error(error.message);
    process.exitCode = error.exitCode;
    return;
  }

  if (!reportedToParent) console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
