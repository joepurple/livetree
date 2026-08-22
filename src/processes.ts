export async function stopProcessGroupAndWait(pid: number, timeoutMs = 5000): Promise<void> {
  killProcessGroup(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      return;
    }

    await sleep(100);
  }

  killProcessGroup(pid, "SIGKILL");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
  let killed = false;
  try {
    process.kill(-pid, signal);
    killed = true;
  } catch {
    // No process group of its own (or already gone); fall back to the single pid.
  }

  try {
    process.kill(pid, signal);
    killed = true;
  } catch {
    // Already exited.
  }

  return killed;
}

export function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") {
    return 130;
  }

  if (signal === "SIGTERM") {
    return 143;
  }

  return 1;
}
