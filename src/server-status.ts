export const SERVER_STARTUP_GRACE_MS = 30_000;

export type ServerLifecycleStatus = "stopped" | "starting" | "healthy" | "failed";
export type WorktreeServerStatus = "idle" | "starting" | "healthy" | "failed";

type ServerSnapshot = {
  running: boolean;
  healthy: boolean;
  startedAtMs: number | null;
};

export function serverLifecycleStatus(server: ServerSnapshot, now = Date.now()): ServerLifecycleStatus {
  if (!server.running) return "stopped";
  if (server.healthy) return "healthy";
  if (server.startedAtMs !== null && now - server.startedAtMs < SERVER_STARTUP_GRACE_MS) return "starting";
  return "failed";
}

export function worktreeServerStatus(servers: readonly ServerSnapshot[], now = Date.now()): WorktreeServerStatus {
  let running = false;
  let starting = false;

  for (const server of servers) {
    const status = serverLifecycleStatus(server, now);
    if (status === "failed") return "failed";
    if (status === "starting") starting = true;
    if (status !== "stopped") running = true;
  }

  if (!running) return "idle";
  return starting ? "starting" : "healthy";
}

export function worktreeServerStatusLabel(status: WorktreeServerStatus): string {
  switch (status) {
    case "failed": return "One or more servers failed";
    case "starting": return "One or more servers starting";
    case "healthy": return "All running servers healthy";
    case "idle": return "No servers running";
  }
}
