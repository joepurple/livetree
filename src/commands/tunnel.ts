import type { ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { readLtConfig } from "../config.js";
import { CliError } from "../errors.js";
import { templateTokens } from "../interpolate.js";
import { portlessName } from "../naming.js";
import { probeAppReachable, proxyInfo, registeredAppPort } from "../portless.js";
import type { ProxyInfo } from "../portless.js";
import { killProcessGroup, stopProcessGroupAndWait } from "../processes.js";
import { clearTunnelEnvPending, markTunnelEnvPending, readServerEntry, readTunnelEntries, readTunnelEntry, removeServerEntry, removeTunnelEntry, tunnelLogPath, writeTunnelEntry } from "../registry.js";
import { nextTailscaleServePort, readTailscaleInfo, startTailscaleServe, tailscaleUrl, usedTailscaleServePorts, waitForTailscaleServe } from "../tailscale.js";
import type { TailscaleInfo } from "../tailscale.js";
import type { LtConfig, ProjectContext, TunnelEntry, WorktreeRecord } from "../types.js";
import { currentWorktree } from "../worktrees.js";
import { devTokenResolver, fingerprintDevEnv, formatAvailableDevScripts, resolveDevEnv, startDevProcess } from "./dev.js";

export type CreatedTunnel = {
  child: ChildProcess;
  entry: TunnelEntry;
};

export type EnsureTunnelOptions = {
  tailscale: TailscaleInfo;
  proxy: ProxyInfo;
  detached: boolean;
  created: CreatedTunnel[];
  log: (message: string) => void;
  visited?: Set<string>;
};

const USAGE = "Usage: livetree tunnel <script> | livetree tunnel stop [<script>|all]";
const MAX_SERVE_PORT_ATTEMPTS = 3;

class ManualRestartRequiredError extends CliError {}

export async function runTunnelCommand(context: ProjectContext, args: string[]): Promise<void> {
  if (args[0] === "stop") {
    await stopTunnels(context, args.slice(1));
    return;
  }

  const scriptName = args[0];
  if (!scriptName || args.length > 1) {
    throw new CliError(USAGE);
  }

  const config = readLtConfig(context);
  const worktree = currentWorktree(context);
  const tailscale = readTailscaleInfo();
  const created: CreatedTunnel[] = [];
  let entry: TunnelEntry;
  try {
    entry = await ensureTunnelForScript(context, config, worktree, scriptName, {
      tailscale,
      proxy: proxyInfo(),
      detached: false,
      created,
      log: (message) => console.error(message),
    });
  } catch (error) {
    if (!(error instanceof ManualRestartRequiredError)) {
      await Promise.all(created.map(async (tunnel) => {
        await stopProcessGroupAndWait(tunnel.entry.pid);
        removeTunnelEntry(context.stateDir, tunnel.entry.name);
      }));
    }
    throw error;
  }

  for (const tunnel of created) {
    console.log(`${tunnel.entry.script} → ${tunnel.entry.url}`);
  }

  if (created.length === 0) {
    console.log(`${entry.script} → ${entry.url}`);
    console.error(`Tunnel for '${scriptName}' is already running; leaving it as is.`);
    return;
  }

  console.error("Press Ctrl-C to stop.");
  await waitForForegroundTunnels(context, created);
}

export async function ensureTunnelForScript(
  context: ProjectContext,
  config: LtConfig,
  worktree: WorktreeRecord,
  scriptName: string,
  options: EnsureTunnelOptions,
): Promise<TunnelEntry> {
  const script = config.devScripts[scriptName];
  if (!script) {
    throw new CliError(`No dev script named '${scriptName}' in ${config.configPath}.${formatAvailableDevScripts(config)}`);
  }

  const name = portlessName(config.name, worktree, scriptName);
  const existing = readTunnelEntry(context.stateDir, name);
  const visited = new Set(options.visited ?? []);
  if (visited.has(name)) {
    throw new CliError(`Tunnel dependencies form a cycle involving '${scriptName}'. Check the \${tunnelUrl:...} references in ${config.configPath}.`);
  }

  visited.add(name);

  if (!readServerEntry(context.stateDir, name)) {
    throw new CliError(`No running dev server for '${scriptName}' in this worktree. Start it first: livetree dev ${scriptName}`);
  }

  const dependencies = [...new Set(
    Object.values(script.tunnelEnv)
      .flatMap((template) => templateTokens(template))
      .filter((token) => token.kind === "tunnelUrl" && token.script !== scriptName)
      .map((token) => token.script),
  )];
  for (const dependency of dependencies) {
    await ensureTunnelForScript(context, config, worktree, dependency, { ...options, visited });
  }

  await restartDevServerIfEnvChanged(context, config, worktree, scriptName, options);
  if (existing) {
    return existing;
  }

  const entry = await openTunnel(context, worktree, scriptName, name, script.tunnelPort, options);
  options.log(`Tunnel ready: ${scriptName} → ${entry.url}`);
  return entry;
}

async function restartDevServerIfEnvChanged(
  context: ProjectContext,
  config: LtConfig,
  worktree: WorktreeRecord,
  scriptName: string,
  options: EnsureTunnelOptions,
): Promise<void> {
  const script = config.devScripts[scriptName]!;
  const name = portlessName(config.name, worktree, scriptName);
  const server = readServerEntry(context.stateDir, name);
  if (!server) {
    throw new CliError(`The dev server for '${scriptName}' stopped while setting up tunnels. Start it again: livetree dev ${scriptName}`);
  }

  const resolver = devTokenResolver(context, config, worktree, options.proxy);
  const desiredEnv = resolveDevEnv({ ...script.env, ...script.tunnelEnv }, resolver);
  if (fingerprintDevEnv(desiredEnv) === (server.envFingerprint ?? fingerprintDevEnv(server.env ?? {}))) {
    return;
  }

  if (!server.managed) {
    markTunnelEnvPending(context.stateDir, name);
    throw new ManualRestartRequiredError(
      `'${scriptName}' is running with a stale environment (its tunnelEnv values changed) and was started outside livetree serve, so it cannot be restarted automatically.\n`
      + `Restart it yourself: press Ctrl-C where 'livetree dev ${scriptName}' is running, then run 'livetree dev ${scriptName}' again.`,
    );
  }

  options.log(`Restarting '${scriptName}' with its tunnel environment...`);
  await stopProcessGroupAndWait(server.pid);
  removeServerEntry(context.stateDir, name);
  await startDevProcess(context, config, worktree, scriptName, { proxy: options.proxy, managed: true, tunneled: true });
  clearTunnelEnvPending(context.stateDir, name);
}

async function openTunnel(
  context: ProjectContext,
  worktree: WorktreeRecord,
  scriptName: string,
  name: string,
  tunnelPort: "auto" | "app",
  options: EnsureTunnelOptions,
): Promise<TunnelEntry> {
  if (!(await probeAppReachable(name, options.proxy, 3_000))) {
    throw new CliError(
      `The dev server for '${scriptName}' is registered but is not reachable at ${name}.localhost.\n`
      + "Restart it and check its log before opening a tunnel.",
    );
  }

  options.log(`Opening tunnel for '${scriptName}'...`);
  const logPath = tunnelLogPath(context.stateDir, name);
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const server = readServerEntry(context.stateDir, name);
  const localPort = server?.appPort ?? registeredAppPort(name);
  if (!localPort) {
    throw new CliError(`Could not determine the application port for '${scriptName}'. Restart its dev server and try again.`);
  }

  const usedPorts = usedTailscaleServePorts(options.tailscale.binPath);
  for (const tunnel of readTunnelEntries(context.stateDir)) {
    if (tunnel.httpsPort) usedPorts.add(tunnel.httpsPort);
  }

  if (tunnelPort === "app" && usedPorts.has(localPort)) {
    throw new CliError(
      `Cannot share '${scriptName}' on HTTPS port ${localPort} because that Tailscale Serve port is already in use.`,
    );
  }

  let lastError: unknown;
  const maxAttempts = tunnelPort === "app" ? 1 : MAX_SERVE_PORT_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const httpsPort = tunnelPort === "app" ? localPort : nextTailscaleServePort(usedPorts);
    usedPorts.add(httpsPort);
    try {
      return await openTailscaleServe(context, worktree, scriptName, name, localPort, httpsPort, options, logPath);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !/already in use|port conflict|address already/i.test(String(error))) throw error;
      options.log(`Tailscale HTTPS port ${httpsPort} was busy; trying another port...`);
    }
  }

  throw lastError;
}

async function openTailscaleServe(
  context: ProjectContext,
  worktree: WorktreeRecord,
  scriptName: string,
  name: string,
  localPort: number,
  httpsPort: number,
  options: EnsureTunnelOptions,
  logPath: string,
): Promise<TunnelEntry> {
  const logFd = openSync(logPath, "a", 0o600);
  let logOpen = true;
  const closeLog = (): void => {
    if (!logOpen) return;
    logOpen = false;
    closeSync(logFd);
  };
  const handle = startTailscaleServe(options.tailscale, localPort, httpsPort, {
    onOutput: (text) => {
      try { writeSync(logFd, text); } catch { /* best effort */ }
    },
  });
  if (!handle.child.pid) {
    closeLog();
    throw new CliError(`Failed to start Tailscale Serve for '${scriptName}'.`);
  }

  const pid = handle.child.pid;
  handle.child.on("exit", () => {
    closeLog();
    if (readTunnelEntry(context.stateDir, name)?.pid === pid) removeTunnelEntry(context.stateDir, name);
  });
  const url = tailscaleUrl(options.tailscale, httpsPort);
  options.log(`Waiting for Tailscale Serve at ${url}...`);
  try {
    await waitForTailscaleServe(handle, url);
  } catch (error) {
    await stopProcessGroupAndWait(pid);
    closeLog();
    throw error;
  }

  const entry: TunnelEntry = {
    name,
    script: scriptName,
    worktree: worktree.path,
    pid,
    httpsPort,
    url,
    startedAtMs: Date.now(),
  };
  writeTunnelEntry(context.stateDir, entry);
  if (options.detached) handle.child.unref();
  options.created.push({ child: handle.child, entry });
  return entry;
}

function waitForForegroundTunnels(context: ProjectContext, created: CreatedTunnel[]): Promise<void> {
  return new Promise((resolve) => {
    let remaining = created.length;

    const finishOne = (): void => {
      remaining -= 1;
      if (remaining === 0) {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        resolve();
      }
    };

    const onSignal = (): void => {
      console.error("\nStopping tunnels...");
      for (const tunnel of created) {
        killProcessGroup(tunnel.entry.pid, "SIGTERM");
      }
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    for (const tunnel of created) {
      if (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null) {
        finishOne();
        continue;
      }

      tunnel.child.on("exit", finishOne);
    }
  });
}

async function stopTunnels(context: ProjectContext, args: string[]): Promise<void> {
  if (args.length > 1) {
    throw new CliError(USAGE);
  }

  const target = args[0] ?? null;
  let entries: TunnelEntry[];
  if (target === "all") {
    entries = readTunnelEntries(context.stateDir);
  } else if (target) {
    const config = readLtConfig(context);
    if (!config.devScripts[target]) {
      throw new CliError(`No dev script named '${target}' in ${config.configPath}.${formatAvailableDevScripts(config)}`);
    }

    const name = portlessName(config.name, currentWorktree(context), target);
    entries = readTunnelEntries(context.stateDir).filter((entry) => entry.name === name);
  } else {
    entries = readTunnelEntries(context.stateDir).filter((entry) => entry.worktree === context.currentRoot);
  }

  if (entries.length === 0) {
    console.log(target && target !== "all" ? `No tunnel running for '${target}' in this worktree.` : "No tunnels running.");
    return;
  }

  for (const entry of entries) {
    await stopProcessGroupAndWait(entry.pid);
    removeTunnelEntry(context.stateDir, entry.name);
    clearTunnelEnvPending(context.stateDir, entry.name);
    console.log(`Stopped tunnel ${entry.script} (${entry.url})`);
  }
}
