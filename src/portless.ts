import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, errorMessage } from "./errors.js";

export type ProxyInfo = {
  port: number;
  tls: boolean;
};

const PROBE_TIMEOUT_MS = 500;
export const DEFAULT_PROXY_PORT = 1355;

export function resolvePortlessCli(): string {
  let packagePath: string;
  try {
    packagePath = createRequire(import.meta.url).resolve("portless/package.json");
  } catch (error) {
    try {
      packagePath = findDependencyPackageJson(fileURLToPath(import.meta.url), "portless");
    } catch {
      throw new CliError(
        `Cannot resolve the bundled portless package: ${errorMessage(error)}\n\nReinstall livetree (npm install -g livetree) so its dependencies are present.`,
      );
    }
  }

  const packageDir = path.dirname(packagePath);
  const bin = (JSON.parse(readFileSync(packagePath, "utf8")) as { bin?: Record<string, string> }).bin?.portless;
  if (!bin) {
    throw new CliError(`The installed portless package at ${packageDir} has no 'portless' bin entry. Reinstall livetree.`);
  }

  return path.join(packageDir, bin);
}

function findDependencyPackageJson(fromPath: string, packageName: string): string {
  let directory = path.dirname(fromPath);
  while (true) {
    const candidate = path.join(directory, "node_modules", packageName, "package.json");
    if (existsSync(candidate)) {
      try {
        if ((JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }).name === packageName) return candidate;
      } catch {
        // Keep walking toward the filesystem root.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Could not locate ${packageName}/package.json from ${fromPath}`);
    directory = parent;
  }
}

export function portlessStateDir(): string {
  return process.env.PORTLESS_STATE_DIR ?? path.join(os.homedir(), ".portless");
}

export function registeredAppPort(name: string): number | null {
  try {
    const routes = JSON.parse(readFileSync(path.join(portlessStateDir(), "routes.json"), "utf8")) as unknown;
    if (!Array.isArray(routes)) return null;
    const route = routes.find((value): value is { hostname: string; port: number } => {
      if (!value || typeof value !== "object") return false;
      const candidate = value as { hostname?: unknown; port?: unknown };
      return candidate.hostname === `${name}.localhost` && Number.isInteger(candidate.port) && Number(candidate.port) > 1023;
    });
    return route?.port ?? null;
  } catch {
    return null;
  }
}

export function proxyInfo(): ProxyInfo {
  const stateDir = portlessStateDir();
  let port = DEFAULT_PROXY_PORT;
  try {
    const value = Number.parseInt(readFileSync(path.join(stateDir, "proxy.port"), "utf8").trim(), 10);
    // Livetree never attaches to a privileged proxy, even if another portless
    // installation left one recorded in the shared state directory.
    if (Number.isInteger(value) && value > 1023) {
      port = value;
    }
  } catch {
    // No proxy state yet; assume the default HTTPS port.
  }

  return { port, tls: !proxyStateSaysPlainHttp(stateDir) };
}

function proxyStateSaysPlainHttp(stateDir: string): boolean {
  return existsSync(path.join(stateDir, "proxy.port")) && !existsSync(path.join(stateDir, "proxy.tls"));
}

export function urlForName(name: string, proxy: ProxyInfo = proxyInfo()): string {
  const scheme = proxy.tls ? "https" : "http";
  const defaultPort = proxy.tls ? 443 : 80;
  const suffix = proxy.port === defaultPort ? "" : `:${proxy.port}`;
  return `${scheme}://${name}.localhost${suffix}`;
}

export function isProxyRunning(proxy: ProxyInfo = proxyInfo()): Promise<boolean> {
  return new Promise((resolve) => {
    const transport = proxy.tls ? https : http;
    const request = transport.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        method: "HEAD",
        path: "/",
        timeout: PROBE_TIMEOUT_MS,
        rejectUnauthorized: false,
      },
      (response) => {
        response.resume();
        resolve(response.headers["x-portless"] === "1");
      },
    );

    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
    request.end();
  });
}

export function probeAppReachable(name: string, proxy: ProxyInfo = proxyInfo(), timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const transport = proxy.tls ? https : http;
    const host = `${name}.localhost`;
    const request = transport.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        method: "HEAD",
        path: "/",
        timeout: timeoutMs,
        rejectUnauthorized: false,
        servername: host,
        headers: { host },
      },
      (response) => {
        response.resume();
        // An application's own 500 still proves it accepted the request. These
        // gateway statuses indicate that portless could not reach the app.
        resolve(![502, 503, 504].includes(response.statusCode ?? 502));
      },
    );

    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
    request.end();
  });
}

export async function ensureProxyRunning(): Promise<ProxyInfo> {
  let proxy = proxyInfo();
  if (await isProxyRunning(proxy)) {
    return proxy;
  }

  const cli = resolvePortlessCli();
  console.error(`Starting portless proxy on unprivileged port ${DEFAULT_PROXY_PORT}...`);
  const result = spawnSync(process.execPath, [cli, "proxy", "start", "--port", String(DEFAULT_PROXY_PORT)], {
    env: portlessChildEnv(process.env),
    stdio: "inherit",
  });

  if (result.error || (result.status !== null && result.status !== 0)) {
    throw new CliError(
      `Failed to start the portless proxy${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}.\n\nRun 'npx portless doctor' from ${path.dirname(path.dirname(cli))} to diagnose, or start it manually with 'npx portless proxy start --port ${DEFAULT_PROXY_PORT}'.`,
    );
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    proxy = proxyInfo();
    if (await isProxyRunning(proxy)) {
      return proxy;
    }

    await sleep(250);
  }

  throw new CliError(`The portless proxy did not become reachable on port ${DEFAULT_PROXY_PORT} after 'proxy start'. Check its log with 'npx portless doctor'.`);
}

export function portlessChildEnv(baseEnv: NodeJS.ProcessEnv, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...extraEnv };
  // Portless refuses to run when it thinks it was invoked via `npx portless`;
  // livetree itself may run under npx, so drop the package-runner markers.
  delete env.npm_command;
  delete env.npm_lifecycle_event;
  delete env.PNPM_SCRIPT_SRC_DIR;
  return env;
}

export function portlessAppArgs(name: string, commandArgs: string[], appPort: number | null): string[] {
  const portFlags = appPort === null ? [] : ["--app-port", String(appPort)];
  return [name, ...portFlags, "--", ...commandArgs];
}

export function splitCommand(cmd: string): string[] {
  const words: string[] = [];
  let current = "";
  let hasCurrent = false;
  let index = 0;

  const push = (): void => {
    if (hasCurrent) {
      words.push(current);
      current = "";
      hasCurrent = false;
    }
  };

  while (index < cmd.length) {
    const char = cmd[index]!;

    if (/\s/.test(char)) {
      push();
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const closing = cmd.indexOf(char, index + 1);
      if (closing === -1) {
        throw new CliError(`Unbalanced ${char} quote in dev command: ${cmd}`);
      }

      current += cmd.slice(index + 1, closing);
      hasCurrent = true;
      index = closing + 1;
      continue;
    }

    if (char === "\\" && index + 1 < cmd.length) {
      current += cmd[index + 1];
      hasCurrent = true;
      index += 2;
      continue;
    }

    if ("&|;<>()`$".includes(char)) {
      throw new CliError(
        `Dev commands run without a shell, so '${char}' is not supported: ${cmd}\n\nWrap the command in a shell explicitly if you need shell features:\n  cmd: sh -c '...'`,
      );
    }

    current += char;
    hasCurrent = true;
    index += 1;
  }

  push();
  if (words.length === 0) {
    throw new CliError("Dev command is empty.");
  }

  return words;
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not allocate a free port.")));
      }
    });
  });
}

export function probeLocalPort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export async function waitForLocalPort(port: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probeLocalPort(port)) return true;
    await sleep(100);
  } while (Date.now() < deadline);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
