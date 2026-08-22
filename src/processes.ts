import { spawnSync } from "node:child_process";

export async function stopProcessGroupAndWait(pid: number, timeoutMs = 5000): Promise<void> {
  // Portless starts the application in its own detached process group. Capture
  // descendants before signaling the wrapper so we can still stop that second
  // group if the wrapper exits before forwarding the signal.
  const processTree = processTreePids(pid);
  for (const processPid of processTree) {
    killProcessGroup(processPid, "SIGTERM");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processTree.every((processPid) => !pidAlive(processPid))) {
      return;
    }

    await sleep(100);
  }

  for (const processPid of processTree) {
    if (pidAlive(processPid)) killProcessGroup(processPid, "SIGKILL");
  }
}

export function processTreePids(rootPid: number): number[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || process.platform === "win32") return [rootPid];
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (result.error || result.status !== 0) return [rootPid];

  const children = new Map<number, number[]>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const childPid = Number.parseInt(match[1]!, 10);
    const parentPid = Number.parseInt(match[2]!, 10);
    const siblings = children.get(parentPid) ?? [];
    siblings.push(childPid);
    children.set(parentPid, siblings);
  }

  const tree = [rootPid];
  const seen = new Set(tree);
  for (let index = 0; index < tree.length; index += 1) {
    for (const childPid of children.get(tree[index]!) ?? []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      tree.push(childPid);
    }
  }
  return tree;
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
