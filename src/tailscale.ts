import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { CliError } from "./errors.js";

export type TailscaleInfo = {
  binPath: string;
  dnsName: string;
  baseUrl: string;
};

export type TailscaleServeHandle = {
  child: ChildProcess;
  output: () => string;
};

type TailscaleStatus = {
  BackendState?: unknown;
  Self?: {
    DNSName?: unknown;
    HostName?: unknown;
    Online?: unknown;
  };
  CurrentTailnet?: {
    MagicDNSSuffix?: unknown;
  };
};

const PREFERRED_HTTPS_PORTS = [443, 8443];

export function resolveTailscaleCli(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LIVETREE_TAILSCALE_BIN;
  if (override) {
    if (!isExecutable(override)) throw new CliError(`LIVETREE_TAILSCALE_BIN is not executable: ${override}`);
    return override;
  }

  const candidates = (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, "tailscale"));
  if (process.platform === "darwin") {
    // The macOS CLI shim launches the app binary and exits immediately. Spawn
    // the app binary itself so its PID and foreground Serve lifecycle stay owned.
    candidates.unshift("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  }
  candidates.push("/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale");
  const match = candidates.find(isExecutable);
  if (match) return match;

  throw new CliError(
    "Tailscale CLI not found. Install Tailscale, connect this Mac to your tailnet, and ensure 'tailscale' is on PATH.",
  );
}

export function readTailscaleInfo(binPath = resolveTailscaleCli()): TailscaleInfo {
  const result = spawnSync(binPath, ["status", "--json"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new CliError(`Could not read Tailscale status: ${result.error?.message ?? (result.stderr.trim() || "unknown error")}`);
  }

  let status: TailscaleStatus;
  try {
    status = JSON.parse(result.stdout) as TailscaleStatus;
  } catch {
    throw new CliError("Tailscale returned malformed status JSON.");
  }

  if (status.BackendState !== "Running" || status.Self?.Online === false) {
    throw new CliError("Tailscale is not connected. Open Tailscale or run 'tailscale up', then try again.");
  }

  const dnsName = tailscaleDnsName(status);
  return { binPath, dnsName, baseUrl: `https://${dnsName}` };
}

export function tailscaleDnsName(status: TailscaleStatus): string {
  if (typeof status.Self?.DNSName === "string" && status.Self.DNSName) {
    return status.Self.DNSName.replace(/\.+$/, "");
  }

  const host = status.Self?.HostName;
  const suffix = status.CurrentTailnet?.MagicDNSSuffix;
  if (typeof host === "string" && host && typeof suffix === "string" && suffix) {
    return `${host}.${suffix.replace(/\.+$/, "")}`;
  }

  throw new CliError("Could not determine this Mac's Tailscale DNS name. Make sure MagicDNS is enabled.");
}

export function usedTailscaleServePorts(binPath: string): Set<number> {
  const result = spawnSync(binPath, ["serve", "status", "--json"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return new Set();
  return tailscaleServePortsFromStatus(result.stdout);
}

export function tailscaleServePortsFromStatus(raw: string): Set<number> {
  try {
    const status = JSON.parse(raw) as unknown;
    const ports = new Set<number>();
    collectServePorts(status, ports);
    return ports;
  } catch {
    return new Set();
  }
}

export function nextTailscaleServePort(used: Set<number>): number {
  for (const port of PREFERRED_HTTPS_PORTS) {
    if (!used.has(port)) return port;
  }

  let port = PREFERRED_HTTPS_PORTS.at(-1)! + 1;
  while (used.has(port)) port += 1;
  return port;
}

export function tailscaleUrl(info: Pick<TailscaleInfo, "baseUrl">, httpsPort: number): string {
  return httpsPort === 443 ? info.baseUrl : `${info.baseUrl}:${httpsPort}`;
}

export function tailscaleServeArgs(localPort: number, httpsPort: number): string[] {
  return ["serve", "--yes", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`];
}

export function startTailscaleServe(
  info: TailscaleInfo,
  localPort: number,
  httpsPort: number,
  options: { onOutput?: (text: string) => void } = {},
): TailscaleServeHandle {
  const child = spawn(info.binPath, tailscaleServeArgs(localPort, httpsPort), {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    output = (output + text).slice(-8000);
    options.onOutput?.(text);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  return { child, output: () => output };
}

export function detachTailscaleServe(handle: TailscaleServeHandle): void {
  handle.child.unref();
  // ChildProcess.unref() does not unref piped stdout/stderr. Without this, a
  // dashboard that created a detached Serve process can close its HTTP server
  // yet remain alive indefinitely because these pipe handles are still active.
  for (const stream of [handle.child.stdout, handle.child.stderr]) {
    (stream as (NodeJS.ReadableStream & { unref?: () => void }) | null)?.unref?.();
  }
}

export async function waitForTailscaleServe(
  handle: TailscaleServeHandle,
  url: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      throw tailscaleServeError(handle.output());
    }

    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
      void response.body?.cancel();
      if (![502, 503, 504].includes(response.status)) return;
    } catch {
      // Tailscale may still be provisioning HTTPS or installing the Serve rule.
    }
    await sleep(500);
  }

  throw new CliError(`Tailscale Serve did not become reachable at ${url}.${formatOutput(handle.output())}`);
}

function collectServePorts(value: unknown, ports: Set<number>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.Web && typeof record.Web === "object" && !Array.isArray(record.Web)) {
    for (const hostPort of Object.keys(record.Web as Record<string, unknown>)) {
      const match = /:(\d+)$/.exec(hostPort);
      if (match) ports.add(Number.parseInt(match[1]!, 10));
    }
  }
  if (record.TCP && typeof record.TCP === "object" && !Array.isArray(record.TCP)) {
    for (const value of Object.keys(record.TCP as Record<string, unknown>)) {
      const port = Number.parseInt(value, 10);
      if (Number.isInteger(port)) ports.add(port);
    }
  }
  for (const nested of Object.values(record)) collectServePorts(nested, ports);
}

export function tailscaleServeError(output: string): CliError {
  const normalized = output.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (/Serve is not enabled on your tailnet/i.test(normalized)) {
    const approval = /https:\/\/login\.tailscale\.com\/f\/serve\?[^\s]+/.exec(normalized)?.[0];
    return new CliError(`Tailscale Serve is not enabled for this tailnet.${approval ? ` Approve it here: ${approval}` : ""}`);
  }
  return new CliError(`Tailscale Serve failed.${formatOutput(normalized)}`);
}

function formatOutput(output: string): string {
  const normalized = output.replace(/\s+/g, " ").trim();
  return normalized ? ` Tailscale said: ${normalized}` : "";
}

function isExecutable(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
