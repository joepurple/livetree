import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnSyncReturns } from "node:child_process";
import { mkdirSync } from "node:fs";
import { CliError } from "../errors.js";
import { readRunnableLivetreeSource, requireRunnableLivetreeSource } from "../source.js";
import type { LivetreeSourceSnapshot, ProjectContext } from "../types.js";

export function runShellCommand(context: ProjectContext, args: string[], commandName = ":"): void {
  if (args.length === 0) {
    throw new CliError(`Usage: lt ${commandName} <shell-command> [args...]`);
  }

  const snapshot = requireRunnableLivetreeSource(context);
  const command = shellCommandFromArgs(args);
  const result = spawnSync(command, {
    cwd: snapshot.source,
    env: shellCommandEnv(context, snapshot.source),
    shell: true,
    stdio: "inherit",
  });

  assertShellCommandResult(result);
}

export async function watchShellCommand(context: ProjectContext, args: string[]): Promise<void> {
  if (args.length === 0) {
    throw new CliError("Usage: lt watch: <shell-command> [args...]");
  }

  const command = shellCommandFromArgs(args);
  mkdirSync(context.liveDir, { recursive: true });
  let current = requireRunnableLivetreeSource(context);
  let child: ChildProcess | null = null;
  let stoppingChild: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  let sourceAvailable = true;
  let missingLogged = false;
  let poll: NodeJS.Timeout | null = null;

  console.error(`lt watch: watching ${context.srcLink}`);

  const start = (snapshot: LivetreeSourceSnapshot): void => {
    current = snapshot;
    sourceAvailable = true;
    missingLogged = false;
    console.error(`lt watch: starting for ${snapshot.source}`);
    const startedChild = spawn(command, {
      cwd: snapshot.source,
      env: shellCommandEnv(context, snapshot.source),
      shell: true,
      stdio: "inherit",
    });
    child = startedChild;

    startedChild.on("error", (error) => {
      if (startedChild === child && !shuttingDown) {
        child = null;
        console.error(`lt watch: shell command failed to start: ${error.message}`);
      }
    });

    startedChild.on("exit", (code, signal) => {
      if (startedChild === stoppingChild || startedChild !== child || restarting || shuttingDown) {
        return;
      }

      child = null;
      if (signal) {
        console.error(`lt watch: shell command terminated by signal ${signal}; waiting for live tree change`);
        return;
      }

      if (code && code !== 0) {
        console.error(`lt watch: shell command exited with status ${code}; waiting for live tree change`);
        return;
      }

      console.error("lt watch: shell command exited; waiting for live tree change");
    });
  };

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

    sourceAvailable = false;
    if (!missingLogged) {
      console.error(`lt watch: waiting for ${context.srcLink}`);
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
      if (sourceAvailable || child) {
        void restart(null);
      }
      return;
    }

    if (!sourceAvailable || next.key !== current.key) {
      console.error("lt watch: live tree changed");
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

    rejectRun(new CliError(signal === "SIGINT" ? "Canceled." : `Shell command watcher terminated by signal ${signal}.`, signalExitCode(signal)));
  };

  const onSigint = (): void => {
    void shutdown("SIGINT");
  };

  const onSigterm = (): void => {
    void shutdown("SIGTERM");
  };

  return new Promise((resolve, reject) => {
    rejectRun = reject;
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    start(current);
    poll = setInterval(checkForChange, 1000);
  });
}

function shellCommandFromArgs(args: string[]): string {
  return args.length === 1 ? args[0]! : args.map(shellQuote).join(" ");
}

function shellCommandEnv(context: ProjectContext, activeSourcePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LT_ACTIVE_WORKTREE: activeSourcePath,
    LT_LIVE_DIR: context.liveDir,
    LT_LIVE_SRC: context.srcLink,
    LT_PROJECT_ROOT: context.mainRoot,
  };
}

function shellQuote(value: string): string {
  if (value === "") {
    return "''";
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertShellCommandResult(result: SpawnSyncReturns<Buffer>): void {
  if (result.error) {
    throw new CliError(`Shell command failed to start: ${result.error.message}`);
  }

  if (result.signal) {
    throw new CliError(result.signal === "SIGINT" ? "Canceled." : `Shell command terminated by signal ${result.signal}.`, signalExitCode(result.signal));
  }

  if (result.status && result.status !== 0) {
    throw new CliError(`Shell command exited with status ${result.status}.`, result.status);
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
