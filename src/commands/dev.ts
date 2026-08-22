import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { readLtConfig } from "../config.js";
import { CliError } from "../errors.js";
import { interpolateTemplate, templateTokens } from "../interpolate.js";
import type { TokenResolver } from "../interpolate.js";
import { portlessName } from "../naming.js";
import {
  ensureProxyRunning,
  pickFreePort,
  portlessAppArgs,
  portlessChildEnv,
  resolvePortlessCli,
  splitCommand,
  urlForName,
} from "../portless.js";
import type { ProxyInfo } from "../portless.js";
import { signalExitCode } from "../processes.js";
import { clearTunnelEnvPending, isTunnelEnvPending, readServerEntry, readTunnelEntry, removeServerEntry, serverLogPath, writeServerEntry } from "../registry.js";
import type { LtConfig, ProjectContext, ServerEntry, WorktreeRecord } from "../types.js";
import { currentWorktree } from "../worktrees.js";

export type StartedDevProcess = {
  child: ChildProcess;
  entry: ServerEntry;
};

export async function runDevScript(context: ProjectContext, args: string[], options: { shortcut?: boolean } = {}): Promise<void> {
  const [scriptName, ...extraArgs] = args;
  const config = readLtConfig(context);

  if (!scriptName) {
    throw new CliError(`Usage: livetree dev <script> [args...]${formatAvailableDevScripts(config)}`);
  }

  if (!config.devScripts[scriptName]) {
    if (options.shortcut) {
      throw new CliError(`Unknown command or dev script '${scriptName}'.${formatAvailableDevScripts(config)}`);
    }

    throw new CliError(`No dev script named '${scriptName}' in ${config.configPath}.${formatAvailableDevScripts(config)}`);
  }

  const worktree = currentWorktree(context);
  const proxy = await ensureProxyRunning();
  const tunneled = shouldUseTunnelEnv(context, config, worktree, scriptName, proxy);
  const { child, entry } = await startDevProcess(context, config, worktree, scriptName, { proxy, managed: false, extraArgs, tunneled });
  if (tunneled) clearTunnelEnvPending(context.stateDir, entry.name);

  console.error(`livetree dev ${scriptName} → ${entry.url}`);
  await waitForForegroundDev(context, scriptName, child, entry);
}

export async function startDevProcess(
  context: ProjectContext,
  config: LtConfig,
  worktree: WorktreeRecord,
  scriptName: string,
  options: { proxy: ProxyInfo; managed: boolean; extraArgs?: string[]; tunneled?: boolean },
): Promise<StartedDevProcess> {
  const script = config.devScripts[scriptName];
  if (!script) {
    throw new CliError(`No dev script named '${scriptName}' in ${config.configPath}.${formatAvailableDevScripts(config)}`);
  }

  const name = portlessName(config.name, worktree, scriptName);
  const existing = readServerEntry(context.stateDir, name);
  if (existing) {
    throw new CliError(`Dev script '${scriptName}' is already running in this worktree (pid ${existing.pid}): ${existing.url}`);
  }
  const resolver = devTokenResolver(context, config, worktree, options.proxy);
  const templates = options.tunneled ? { ...script.env, ...script.tunnelEnv } : script.env;
  const env = resolveDevEnv(templates, resolver);

  const commandArgs = [...splitCommand(script.cmd), ...(options.extraArgs ?? [])];
  const appPort = await pickFreePort();
  if (script.portArg) {
    commandArgs.push(...splitCommand(script.portArg), String(appPort));
  }

  const cliPath = resolvePortlessCli();
  const logPath = options.managed ? serverLogPath(context.stateDir, name) : null;
  let logFd: number | null = null;
  let stdio: ("inherit" | "ignore" | number)[] = ["inherit", "inherit", "inherit"];
  if (logPath) {
    mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    logFd = openSync(logPath, "a", 0o600);
    stdio = ["ignore", logFd, logFd];
  }

  const child = spawn(process.execPath, [cliPath, ...portlessAppArgs(name, commandArgs, appPort)], {
    cwd: worktree.path,
    env: portlessChildEnv(process.env, env),
    stdio,
    detached: options.managed,
  });
  if (logFd !== null) closeSync(logFd);

  if (!child.pid) {
    throw new CliError(`Failed to start dev script '${scriptName}'.`);
  }

  if (options.managed) {
    child.unref();
  }

  const entry: ServerEntry = {
    name,
    script: scriptName,
    worktree: worktree.path,
    pid: child.pid,
    appPort,
    url: urlForName(name, options.proxy),
    envFingerprint: fingerprintDevEnv(env),
    tunneled: options.tunneled ?? false,
    startedAtMs: Date.now(),
    managed: options.managed,
    logPath,
  };
  writeServerEntry(context.stateDir, entry);

  return { child, entry };
}

export function fingerprintDevEnv(env: Record<string, string>): string {
  const stable = Object.entries(env).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function shouldUseTunnelEnv(
  context: ProjectContext,
  config: LtConfig,
  worktree: WorktreeRecord,
  scriptName: string,
  proxy: ProxyInfo,
): boolean {
  const script = config.devScripts[scriptName]!;
  if (Object.keys(script.tunnelEnv).length === 0) return false;
  const name = portlessName(config.name, worktree, scriptName);
  if (isTunnelEnvPending(context.stateDir, name) || readTunnelEntry(context.stateDir, name)) return true;
  const tunnelTokens = Object.values(script.tunnelEnv)
    .flatMap((template) => templateTokens(template))
    .filter((token) => token.kind === "tunnelUrl");
  if (tunnelTokens.length === 0) return false;
  try {
    resolveDevEnv({ ...script.env, ...script.tunnelEnv }, devTokenResolver(context, config, worktree, proxy));
    return true;
  } catch (error) {
    if (error instanceof CliError && error.message.startsWith("No tunnel is running")) return false;
    throw error;
  }
}

export function resolveDevEnv(templates: Record<string, string>, resolver: TokenResolver): Record<string, string> {
  return Object.fromEntries(
    Object.entries(templates).map(([key, template]) => [key, interpolateTemplate(template, resolver)]),
  );
}

export function devTokenResolver(context: ProjectContext, config: LtConfig, worktree: WorktreeRecord, proxy: ProxyInfo): TokenResolver {
  return {
    urlForScript: (script) => {
      requireDevScript(config, script);
      return urlForName(portlessName(config.name, worktree, script), proxy);
    },
    tunnelUrlForScript: (script) => {
      requireDevScript(config, script);
      const tunnel = readTunnelEntry(context.stateDir, portlessName(config.name, worktree, script));
      if (!tunnel) {
        throw new CliError(`No tunnel is running for '${script}' in this worktree. Start one with 'livetree tunnel ${script}'.`);
      }

      return tunnel.url;
    },
  };
}

function requireDevScript(config: LtConfig, script: string): void {
  if (!config.devScripts[script]) {
    throw new CliError(`Template references unknown dev script '${script}'.${formatAvailableDevScripts(config)}`);
  }
}

export function formatAvailableDevScripts(config: Pick<LtConfig, "configPath" | "devScripts">): string {
  const names = Object.keys(config.devScripts).sort();
  if (names.length === 0) {
    return `\n\nNo dev scripts are defined in ${config.configPath}. Add one like:\ndev:\n  web:\n    cmd: pnpm --dir modules/web start`;
  }

  return `\n\nAvailable dev scripts:\n${names.map((name) => `  ${name}`).join("\n")}`;
}

function waitForForegroundDev(context: ProjectContext, scriptName: string, child: ChildProcess, entry: ServerEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    // Keep running through Ctrl-C: the terminal delivers SIGINT to the child too,
    // and cleanup happens once the child actually exits.
    const onSignal = (signal: NodeJS.Signals): void => {
      try { child.kill(signal); } catch { /* child already exited */ }
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const cleanup = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (readServerEntry(context.stateDir, entry.name)?.pid === entry.pid) {
        removeServerEntry(context.stateDir, entry.name);
      }
    };

    child.on("error", (error) => {
      cleanup();
      reject(new CliError(`Dev script '${scriptName}' failed to start: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      cleanup();
      if (signal) {
        reject(new CliError(signal === "SIGINT" ? "Canceled." : `Dev script '${scriptName}' terminated by signal ${signal}.`, signalExitCode(signal)));
        return;
      }

      if (code === 130) {
        reject(new CliError("Canceled.", code));
        return;
      }

      if (code && code !== 0) {
        reject(new CliError(`Dev script '${scriptName}' exited with status ${code}.`, code));
        return;
      }

      resolve();
    });
  });
}
