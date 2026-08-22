import { CliError } from "../errors.js";
import { dim, formatRelativeAge } from "../format.js";
import { readServerEntries, readTunnelEntries } from "../registry.js";
import type { ProjectContext, ServerEntry, TunnelEntry } from "../types.js";
import { worktreesModifiedNewestFirst } from "../worktrees.js";

export async function listWorktrees(context: ProjectContext, extraArgs = ""): Promise<void> {
  if (extraArgs.trim()) {
    throw new CliError("Usage: livetree ls");
  }

  const items = worktreesModifiedNewestFirst(context.choices);
  const servers = readServerEntries(context.stateDir);
  const tunnels = new Map(readTunnelEntries(context.stateDir).map((tunnel) => [tunnel.name, tunnel]));
  const ageWidth = Math.max(...items.map((item) => formatRelativeAge(item.modifiedAtMs).length), 1);

  for (const item of items) {
    console.log(`${formatRelativeAge(item.modifiedAtMs).padStart(ageWidth)}  ${item.choice.label}`);
    if (!item.choice.isMain) {
      console.log(`    ${dim(item.choice.path, process.stdout)}`);
    }
    for (const server of servers.filter((entry) => entry.worktree === item.choice.path)) {
      console.log(`    ${formatServerRow(server, tunnels.get(server.name))}`);
    }
  }
}

function formatServerRow(server: ServerEntry, tunnel: TunnelEntry | undefined): string {
  const uptime = formatRelativeAge(server.startedAtMs);
  const tunnelSuffix = tunnel ? `  ⇄ ${tunnel.url}` : "";
  return `${server.script}  ${server.url}  ${dim(`(pid ${server.pid}, up ${uptime})`, process.stdout)}${tunnelSuffix}`;
}
