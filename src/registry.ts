import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ServerEntry, TunnelEntry } from "./types.js";

export function serverLogPath(stateDir: string, name: string): string {
  return path.join(stateDir, "logs", `${name}.log`);
}

export function tunnelLogPath(stateDir: string, name: string): string {
  return path.join(stateDir, "logs", `${name}.tunnel.log`);
}

export function writeServerEntry(stateDir: string, entry: ServerEntry): void {
  writeEntry(path.join(stateDir, "servers"), entry.name, entry);
}

export function removeServerEntry(stateDir: string, name: string): void {
  removeEntry(path.join(stateDir, "servers"), name);
}

export function readServerEntries(stateDir: string): ServerEntry[] {
  return readAliveEntries<ServerEntry>(path.join(stateDir, "servers"));
}

export function readServerEntry(stateDir: string, name: string): ServerEntry | null {
  return readServerEntries(stateDir).find((entry) => entry.name === name) ?? null;
}

export function writeTunnelEntry(stateDir: string, entry: TunnelEntry): void {
  writeEntry(path.join(stateDir, "tunnels"), entry.name, entry);
}

export function removeTunnelEntry(stateDir: string, name: string): void {
  removeEntry(path.join(stateDir, "tunnels"), name);
}

export function readTunnelEntries(stateDir: string): TunnelEntry[] {
  return readAliveEntries<TunnelEntry>(path.join(stateDir, "tunnels"));
}

export function readTunnelEntry(stateDir: string, name: string): TunnelEntry | null {
  return readTunnelEntries(stateDir).find((entry) => entry.name === name) ?? null;
}

export function markTunnelEnvPending(stateDir: string, name: string): void {
  const directory = path.join(stateDir, "pending-tunnel-env");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(path.join(directory, name), "pending\n", { encoding: "utf8", mode: 0o600 });
}

export function isTunnelEnvPending(stateDir: string, name: string): boolean {
  try {
    return readFileSync(path.join(stateDir, "pending-tunnel-env", name), "utf8").trim() === "pending";
  } catch {
    return false;
  }
}

export function clearTunnelEnvPending(stateDir: string, name: string): void {
  rmSync(path.join(stateDir, "pending-tunnel-env", name), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeEntry(directory: string, name: string, entry: object): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const file = path.join(directory, `${name}.json`);
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function removeEntry(directory: string, name: string): void {
  rmSync(path.join(directory, `${name}.json`), { force: true });
}

function readAliveEntries<Entry extends { name: string; pid: number }>(directory: string): Entry[] {
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }

  const entries: Entry[] = [];
  for (const file of files) {
    const filePath = path.join(directory, file);
    let entry: Entry;
    try {
      entry = JSON.parse(readFileSync(filePath, "utf8")) as Entry;
    } catch {
      continue;
    }

    if (typeof entry?.name !== "string" || !isProcessAlive(entry.pid)) {
      rmSync(filePath, { force: true });
      continue;
    }

    entries.push(entry);
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}
