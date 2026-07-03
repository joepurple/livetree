import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnSyncReturns } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readLtConfig } from "../config.js";
import { CliError } from "../errors.js";
import { readRunnableLivetreeSource, requireRunnableLivetreeSource } from "../source.js";
import type { LivetreeSourceSnapshot, ProjectContext, RunConfiguredScriptOptions, RunOptions } from "../types.js";

export async function runConfiguredScript(context: ProjectContext, args: string[], watch: boolean, options: RunConfiguredScriptOptions = {}): Promise<void> {
  const command = watch ? "watch" : "run";
  const usageLine = options.shortcut ? "lt <script-name> [args...]" : `lt ${command} <script-name> [args...]`;
  const runOptions = parseRunArgs(args, command, usageLine, !options.shortcut);
  const config = readLtConfig(context);

  if (!runOptions.scriptName) {
    throw new CliError(`Usage: ${usageLine}${formatAvailableRunScripts(config)}`);
  }

  const script = config.runScripts[runOptions.scriptName];
  if (!script) {
    if (options.shortcut) {
      throw new CliError(
        `Unknown command or run script '${runOptions.scriptName}'. To switch worktrees, use 'lt switch ${args.join(" ")}'.${formatAvailableRunScripts(config)}`,
      );
    }

    throw new CliError(`No run script named '${runOptions.scriptName}' in ${config.configPath}.${formatAvailableRunScripts(config)}`);
  }

  if (watch) {
    await runWatchedScript(context, runOptions.scriptName, script, runOptions.scriptArgs);
  } else {
    runScriptOnce(context, runOptions.scriptName, script, runOptions.scriptArgs);
  }
}

function parseRunArgs(args: string[], command: "run" | "watch", usageLine: string, allowStaticOption: boolean): RunOptions {
  let scriptName: string | null = null;
  const scriptArgs: string[] = [];

  for (const arg of args) {
    if (!scriptName) {
      if (allowStaticOption && command === "run" && arg === "--static") {
        continue;
      }

      if (arg.startsWith("-")) {
        throw new CliError(`Unknown option: ${arg}\n\nUsage: ${usageLine}`);
      }

      scriptName = arg;
      continue;
    }

    scriptArgs.push(arg);
  }

  if (!scriptName) {
    return {
      scriptName: null,
      scriptArgs,
    };
  }

  return {
    scriptName,
    scriptArgs,
  };
}

function formatAvailableRunScripts(config: { configPath: string; runScripts: Record<string, string> }): string {
  const names = Object.keys(config.runScripts).sort();
  if (names.length === 0) {
    return `\n\nNo run scripts are defined in ${config.configPath}. Add one like:\nrun:\n  web: cd src/modules/web && pnpm start`;
  }

  return `\n\nAvailable run scripts:\n${names.map((name) => `  ${name}`).join("\n")}`;
}

function scriptWithArgs(script: string, args: string[]): string {
  if (args.length === 0) {
    return script;
  }

  return `${script} ${args.map(shellQuote).join(" ")}`;
}

function shellQuote(value: string): string {
  if (value === "") {
    return "''";
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runScriptOnce(context: ProjectContext, scriptName: string, script: string, scriptArgs: string[]): void {
  const snapshot = requireRunnableLivetreeSource(context);
  const result = spawnSync(scriptWithArgs(script, scriptArgs), {
    cwd: context.liveDir,
    env: runScriptEnv(context, scriptName, snapshot.source),
    shell: true,
    stdio: "inherit",
  });

  assertRunResult(result, scriptName);
}

async function runWatchedScript(context: ProjectContext, scriptName: string, script: string, scriptArgs: string[]): Promise<void> {
  mkdirSync(context.liveDir, { recursive: true });
  let current = requireRunnableLivetreeSource(context);
  let child: ChildProcess | null = null;
  let stoppingChild: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  let missingLogged = false;
  let poll: NodeJS.Timeout | null = null;

  console.error(`lt watch ${scriptName}: watching ${context.srcLink}`);

  const start = (snapshot: LivetreeSourceSnapshot): void => {
    current = snapshot;
    missingLogged = false;
    console.error(`lt watch ${scriptName}: starting for ${snapshot.source}`);
    const startedChild = spawn(scriptWithArgs(script, scriptArgs), {
      cwd: context.liveDir,
      env: runScriptEnv(context, scriptName, snapshot.source),
      shell: true,
      stdio: "inherit",
    });
    child = startedChild;

    startedChild.on("error", (error) => {
      if (!shuttingDown) {
        cleanup();
        rejectRun(new CliError(`Run script '${scriptName}' failed to start: ${error.message}`));
      }
    });

    startedChild.on("exit", (code, signal) => {
      if (startedChild === stoppingChild || startedChild !== child || restarting || shuttingDown) {
        return;
      }

      cleanup();
      if (signal) {
        rejectRun(new CliError(signal === "SIGINT" ? "Canceled." : `Run script '${scriptName}' terminated by signal ${signal}.`, signalExitCode(signal)));
        return;
      }

      if (code && code !== 0) {
        rejectRun(new CliError(`Run script '${scriptName}' exited with status ${code}.`, code));
        return;
      }

      resolveRun();
    });
  };

  let resolveRun: () => void = () => undefined;
  let rejectRun: (error: CliError) => void = () => undefined;

  const cleanup = (): void => {
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };

  const restart = async (next: LivetreeSourceSnapshot | null): Promise<void> => {
    if (restarting || shuttingDown) {
      return;
    }

    restarting = true;
    const previous = child;
    child = null;

    if (previous) {
      stoppingChild = previous;
      stopChildProcess(previous, "SIGTERM");
      await waitForChildToExit(previous, 5000);
      stoppingChild = null;
    }

    restarting = false;

    if (shuttingDown) {
      return;
    }

    if (next) {
      start(next);
      return;
    }

    if (!missingLogged) {
      console.error(`lt watch ${scriptName}: waiting for ${context.srcLink}`);
      missingLogged = true;
    }
  };

  const checkForChange = (): void => {
    let next: LivetreeSourceSnapshot | null;
    try {
      next = readRunnableLivetreeSource(context);
    } catch (error) {
      cleanup();
      rejectRun(error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error)));
      return;
    }

    if (!next) {
      void restart(null);
      return;
    }

    if (!child || next.key !== current.key) {
      console.error(`lt watch ${scriptName}: live tree changed`);
      void restart(next);
    }
  };

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    cleanup();
    const previous = child;
    child = null;
    if (previous) {
      stopChildProcess(previous, signal);
      await waitForChildToExit(previous, 5000);
    }

    rejectRun(new CliError(signal === "SIGINT" ? "Canceled." : `Run script '${scriptName}' terminated by signal ${signal}.`, signalExitCode(signal)));
  };

  const onSigint = (): void => {
    void shutdown("SIGINT");
  };

  const onSigterm = (): void => {
    void shutdown("SIGTERM");
  };

  return new Promise((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    start(current);
    poll = setInterval(checkForChange, 1000);
  });
}

function runScriptEnv(context: ProjectContext, scriptName: string, activeSourcePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LT_ACTIVE_WORKTREE: activeSourcePath,
    LT_LIVE_DIR: context.liveDir,
    LT_LIVE_SRC: context.srcLink,
    LT_PROJECT_ROOT: context.mainRoot,
    LT_SCRIPT: scriptName,
  };
}

function assertRunResult(result: SpawnSyncReturns<Buffer>, scriptName: string): void {
  if (result.error) {
    throw new CliError(`Run script '${scriptName}' failed to start: ${result.error.message}`);
  }

  if (result.signal) {
    throw new CliError(result.signal === "SIGINT" ? "Canceled." : `Run script '${scriptName}' terminated by signal ${result.signal}.`, signalExitCode(result.signal));
  }

  if (result.status && result.status !== 0) {
    throw new CliError(`Run script '${scriptName}' exited with status ${result.status}.`, result.status);
  }
}

function stopChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }

  stopProcessTree(child.pid, signal);
}

function stopProcessTree(pid: number, signal: NodeJS.Signals): void {
  for (const childPid of childProcessIds(pid)) {
    stopProcessTree(childPid, signal);
  }

  try {
    process.kill(pid, signal);
  } catch {
    // The process already exited.
  }
}

function childProcessIds(pid: number): number[] {
  if (process.platform === "win32") {
    return [];
  }

  try {
    const output = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!output) {
      return [];
    }

    return output
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function waitForChildToExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      stopChildProcess(child, "SIGKILL");
    }, timeoutMs);
    const giveUp = setTimeout(resolve, timeoutMs + 1000);

    child.once("exit", () => {
      clearTimeout(timeout);
      clearTimeout(giveUp);
      resolve();
    });
  });
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") {
    return 130;
  }

  if (signal === "SIGTERM") {
    return 143;
  }

  return 1;
}
