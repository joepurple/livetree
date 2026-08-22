import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, createReadStream, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLtConfig } from "../config.js";
import { CliError, errorMessage } from "../errors.js";
import { gitAsync } from "../git.js";
import { interpolateTemplate } from "../interpolate.js";
import { portlessName } from "../naming.js";
import { ensureProxyRunning, probeAppReachable, proxyInfo, urlForName } from "../portless.js";
import { stopProcessGroupAndWait } from "../processes.js";
import { isConfiguredProject, livetreeHome, registerProject, registeredProjectPaths, unregisterProject } from "../projects.js";
import { qrSvg, qrTerminal } from "../qr.js";
import {
  clearTunnelEnvPending,
  readServerEntries,
  readServerEntry,
  readTunnelEntries,
  readTunnelEntry,
  removeServerEntry,
  removeTunnelEntry,
  isProcessAlive,
} from "../registry.js";
import { nextTailscaleServePort, readTailscaleInfo, startTailscaleServe, tailscaleUrl, usedTailscaleServePorts, waitForTailscaleServe } from "../tailscale.js";
import type { LtConfig, ProjectContext, WorktreeChoice } from "../types.js";
import { buildProjectContext, worktreesModifiedNewestFirst } from "../worktrees.js";
import { startDevProcess } from "./dev.js";
import { ensureTunnelForScript } from "./tunnel.js";

const DEFAULT_PORT = 43117;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_INITIAL_LOG_BYTES = 256 * 1024;
const SERVER_START_USAGE = "Usage: livetree server start [--foreground] [--tailscale|--no-tailscale] [--port <number>]";
const SERVER_STOP_USAGE = "Usage: livetree server stop";
const BACKGROUND_CHILD_ENV = "LIVETREE_SERVE_BACKGROUND_CHILD";

type BackgroundServeMessage =
  | { type: "livetree:serve-ready"; localUrl: string; tailnetUrl: string | null; tailnetError: string | null }
  | { type: "livetree:serve-error"; message: string; exitCode: number };

type BackgroundServeInfo = {
  version: 1;
  pid: number;
  localUrl: string;
  tailnetUrl: string | null;
  tailnetError: string | null;
  startedAtMs: number;
};

type DashboardTailnetState = {
  status: "disabled" | "starting" | "ready" | "unavailable";
  url: string | null;
  error: string | null;
};

type DashboardTailnetRuntime = {
  state: DashboardTailnetState;
  child: ChildProcess | null;
  starting: Promise<string> | null;
  stopping: boolean;
  onChange: () => void;
};

type ActionBody = { project?: unknown; worktree?: unknown; script?: unknown; path?: unknown; force?: unknown };

type DashboardProject = {
  id: string;
  context: ProjectContext;
  config: LtConfig;
};

export function resolveServeContext(cwd: string): ProjectContext | null {
  const candidates = [cwd, ...registeredProjectPaths()];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    try {
      const context = buildProjectContext(candidate);
      if (seen.has(context.mainRoot)) continue;
      seen.add(context.mainRoot);
      if (isConfiguredProject(context.mainRoot)) return context;
    } catch {
      // The current directory may be outside Git and saved projects may have
      // moved or been deleted. Keep looking for the first usable project.
    }
  }

  return null;
}

export async function runServerStartCommand(context: ProjectContext | null, args: string[]): Promise<void> {
  const options = parseServeArgs(args);
  if (options.background) {
    if (options.parentPid !== null) {
      throw new CliError("--background cannot be combined with --parent-pid.");
    }
    const childArgs = args.filter((arg) => arg !== "--background");
    childArgs.push("--foreground");
    await runServeInBackground(childArgs);
    return;
  }

  if (context) {
    const config = readLtConfig(context);
    await reconcileManagedProcesses(context, config);
  }
  const basePath = "/";
  const tailnet: DashboardTailnetRuntime = {
    state: {
      status: options.tailscale ? "starting" : "disabled",
      url: null,
      error: null,
    },
    child: null,
    starting: null,
    stopping: false,
    onChange: () => {},
  };
  let dashboardPort: number | null = null;
  const server = createServer((request, response) => {
    void handleRequest(context, basePath, tailnet, dashboardPort, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new CliError("Could not determine the livetree dashboard port.");
  }

  const localUrl = `http://127.0.0.1:${address.port}${basePath}`;
  dashboardPort = address.port;
  console.log(`Dashboard: ${localUrl}`);

  const backgroundStartedAtMs = isBackgroundServeChild() ? Date.now() : null;
  let backgroundReady = false;
  const persistBackgroundInfo = (): void => {
    if (backgroundStartedAtMs === null) return;
    writeBackgroundServeInfo({
      version: 1,
      pid: process.pid,
      localUrl,
      tailnetUrl: tailnet.state.url,
      tailnetError: tailnet.state.error,
      startedAtMs: backgroundStartedAtMs,
    });
  };
  tailnet.onChange = () => {
    if (!backgroundReady) return;
    try {
      persistBackgroundInfo();
    } catch (error) {
      console.error(`Could not update the background dashboard record: ${errorMessage(error)}`);
    }
  };

  try {
    if (options.tailscale) {
      const url = await startDashboardTailnet(tailnet, address.port);
      console.log(`Tailnet dashboard: ${url}`);
      console.log(qrTerminal(url));
    }
  } catch (error) {
    if (!options.tailscaleOptional) {
      server.close();
      throw error;
    }
    console.error(`Tailnet dashboard unavailable: ${tailnet.state.error ?? errorMessage(error)}`);
  }

  if (backgroundStartedAtMs !== null) {
    try {
      backgroundReady = true;
      persistBackgroundInfo();
    } catch (error) {
      if (tailnet.child?.pid) await stopProcessGroupAndWait(tailnet.child.pid);
      server.close();
      throw new CliError(`Could not record the background dashboard: ${errorMessage(error)}`);
    }
  }

  sendBackgroundServeMessage({ type: "livetree:serve-ready", localUrl, tailnetUrl: tailnet.state.url, tailnetError: tailnet.state.error });
  console.error("Press Ctrl-C to stop.");
  await waitForShutdown(server, tailnet, options.parentPid, () => {
    if (backgroundStartedAtMs !== null) removeBackgroundServeInfo(process.pid, backgroundStartedAtMs);
  });
}

function startDashboardTailnet(runtime: DashboardTailnetRuntime, localPort: number): Promise<string> {
  if (runtime.state.status === "ready" && runtime.state.url && runtime.child) {
    return Promise.resolve(runtime.state.url);
  }
  if (runtime.starting) return runtime.starting;

  const attempt = openDashboardTailnet(runtime, localPort);
  runtime.starting = attempt;
  void attempt.then(
    () => { if (runtime.starting === attempt) runtime.starting = null; },
    () => { if (runtime.starting === attempt) runtime.starting = null; },
  );
  return attempt;
}

async function openDashboardTailnet(runtime: DashboardTailnetRuntime, localPort: number): Promise<string> {
  runtime.state = { status: "starting", url: null, error: null };
  runtime.onChange();
  let child: ChildProcess | null = null;
  try {
    const tailscale = readTailscaleInfo();
    const httpsPort = nextTailscaleServePort(usedTailscaleServePorts(tailscale.binPath));
    const handle = startTailscaleServe(tailscale, localPort, httpsPort);
    child = handle.child;
    if (!child.pid) throw new CliError("Failed to start Tailscale Serve for the dashboard.");
    runtime.child = child;
    const url = tailscaleUrl(tailscale, httpsPort);
    child.once("exit", (code, signal) => {
      if (runtime.child !== child) return;
      runtime.child = null;
      if (runtime.stopping) return;
      const detail = signal ? `signal ${signal}` : `status ${code ?? 1}`;
      runtime.state = { status: "unavailable", url: null, error: `Tailscale Serve stopped (${detail}).` };
      runtime.onChange();
    });
    await waitForTailscaleServe(handle, url);
    runtime.state = { status: "ready", url, error: null };
    runtime.onChange();
    return url;
  } catch (error) {
    if (child?.pid) {
      runtime.child = null;
      await stopProcessGroupAndWait(child.pid);
    }
    runtime.state = { status: "unavailable", url: null, error: errorMessage(error) };
    runtime.onChange();
    throw error;
  }
}

export async function runServerStopCommand(args: string[]): Promise<void> {
  if (args.length > 0) throw new CliError(SERVER_STOP_USAGE);

  const info = readBackgroundServeInfo();
  if (!info || !(await recordedBackgroundServerIsHealthy(info))) {
    clearBackgroundServeInfo();
    throw new CliError("No background LiveTree server is running.");
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch (error) {
    clearBackgroundServeInfo();
    throw new CliError(`Could not stop the background LiveTree server: ${errorMessage(error)}`);
  }

  const deadline = Date.now() + 5_000;
  while (isProcessAlive(info.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (isProcessAlive(info.pid)) {
    throw new CliError(`Background LiveTree server ${info.pid} did not stop within 5 seconds.`);
  }

  removeBackgroundServeInfo(info.pid, info.startedAtMs);
  console.log(`Stopped background LiveTree server (pid ${info.pid}).`);
}

export async function reportBackgroundServeError(error: unknown): Promise<boolean> {
  if (!isBackgroundServeChild() || typeof process.send !== "function") return false;
  const exitCode = error instanceof CliError ? error.exitCode : 1;
  await new Promise<void>((resolve) => {
    process.send!({ type: "livetree:serve-error", message: errorMessage(error), exitCode } satisfies BackgroundServeMessage, () => resolve());
  });
  return true;
}

async function runServeInBackground(args: string[]): Promise<void> {
  const cliPath = process.argv[1];
  if (!cliPath) throw new CliError("Could not determine the livetree executable path.");

  const child = spawn(process.execPath, [cliPath, "server", "start", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, [BACKGROUND_CHILD_ENV]: "1" },
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  if (!child.pid) throw new CliError("Failed to start the livetree dashboard in the background.");

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (child.connected) child.disconnect();
      if (error) {
        reject(error);
        return;
      }
      child.unref();
      resolve();
    };

    child.once("error", (error) => finish(new CliError(`Failed to start the livetree dashboard in the background: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (settled) return;
      const detail = signal ? `signal ${signal}` : `status ${code ?? 1}`;
      finish(new CliError(`The background dashboard exited before it was ready (${detail}).`));
    });
    child.on("message", (value) => {
      if (!isBackgroundServeMessage(value)) return;
      if (value.type === "livetree:serve-error") {
        finish(new CliError(value.message, value.exitCode));
        return;
      }

      console.log(`Dashboard: ${value.localUrl}`);
      if (value.tailnetUrl) console.log(`Tailnet dashboard: ${value.tailnetUrl}`);
      if (value.tailnetError) console.error(`Tailnet dashboard unavailable: ${value.tailnetError}`);
      console.error(`Dashboard is running in the background (pid ${child.pid}).`);
      console.error("Stop it with: livetree server stop");
      finish();
    });
  });
}

function isBackgroundServeChild(): boolean {
  return process.env[BACKGROUND_CHILD_ENV] === "1";
}

function sendBackgroundServeMessage(message: BackgroundServeMessage): void {
  if (!isBackgroundServeChild() || typeof process.send !== "function") return;
  process.send(message);
}

function isBackgroundServeMessage(value: unknown): value is BackgroundServeMessage {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "livetree:serve-ready" || type === "livetree:serve-error";
}

function writeBackgroundServeInfo(info: BackgroundServeInfo): void {
  const home = livetreeHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const file = path.join(home, "serve.json");
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(info, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function readBackgroundServeInfo(): BackgroundServeInfo | null {
  try {
    const value = JSON.parse(readFileSync(backgroundServeInfoPath(), "utf8")) as Partial<BackgroundServeInfo>;
    if (
      value.version !== 1
      || !Number.isInteger(value.pid)
      || value.pid! <= 0
      || typeof value.localUrl !== "string"
      || (value.tailnetUrl !== null && typeof value.tailnetUrl !== "string")
      || (value.tailnetError !== null && typeof value.tailnetError !== "string")
      || !Number.isFinite(value.startedAtMs)
    ) return null;
    return value as BackgroundServeInfo;
  } catch {
    return null;
  }
}

async function recordedBackgroundServerIsHealthy(info: BackgroundServeInfo): Promise<boolean> {
  if (!isProcessAlive(info.pid)) return false;
  try {
    const url = new URL(info.localUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return false;
    const response = await fetch(new URL("api/health", url), { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const value = await response.json() as { service?: unknown; pid?: unknown };
    return value.service === "livetree" && value.pid === info.pid;
  } catch {
    return false;
  }
}

function backgroundServeInfoPath(): string {
  return path.join(livetreeHome(), "serve.json");
}

function clearBackgroundServeInfo(): void {
  try {
    unlinkSync(backgroundServeInfoPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function removeBackgroundServeInfo(pid: number, startedAtMs: number): void {
  const file = backgroundServeInfoPath();
  try {
    const current = JSON.parse(readFileSync(file, "utf8")) as Partial<BackgroundServeInfo>;
    if (current.pid === pid && current.startedAtMs === startedAtMs) unlinkSync(file);
  } catch {
    // The file may already be gone or have been replaced by a newer instance.
  }
}

export async function reconcileManagedProcesses(
  context: ProjectContext,
  config: LtConfig,
  options: { stop?: (pid: number) => Promise<void>; log?: (message: string) => void } = {},
): Promise<void> {
  const stop = options.stop ?? stopProcessGroupAndWait;
  const log = options.log ?? ((message: string) => console.error(message));
  const validNames = new Set(
    context.choices.flatMap((worktree) => Object.keys(config.devScripts).map((script) => portlessName(config.name, worktree, script))),
  );

  for (const tunnel of readTunnelEntries(context.stateDir)) {
    if (validNames.has(tunnel.name)) continue;
    log(`Stopping orphaned tunnel '${tunnel.name}'...`);
    await stop(tunnel.pid);
    removeTunnelEntry(context.stateDir, tunnel.name);
    clearTunnelEnvPending(context.stateDir, tunnel.name);
  }

  for (const server of readServerEntries(context.stateDir)) {
    if (validNames.has(server.name) || !server.managed) continue;
    log(`Stopping orphaned dev server '${server.name}'...`);
    await stop(server.pid);
    removeServerEntry(context.stateDir, server.name);
    clearTunnelEnvPending(context.stateDir, server.name);
  }
}

function parseServeArgs(args: string[]): { background: boolean; tailscale: boolean; tailscaleOptional: boolean; noTailscale: boolean; port: number; parentPid: number | null } {
  let background = true;
  let tailscale = true;
  let tailscaleOptional = true;
  let noTailscale = false;
  let port = DEFAULT_PORT;
  let parentPid: number | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--background") {
      background = true;
    } else if (arg === "--foreground") {
      background = false;
    } else if (arg === "--tailscale") {
      tailscale = true;
      tailscaleOptional = false;
    } else if (arg === "--tailscale-optional") {
      tailscale = true;
      tailscaleOptional = true;
    } else if (arg === "--no-tailscale") {
      tailscale = false;
      tailscaleOptional = false;
      noTailscale = true;
    } else if (arg === "--port") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new CliError(SERVER_START_USAGE);
      }
      port = value;
      index += 1;
    } else if (arg === "--parent-pid") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isInteger(value) || value <= 0) {
        throw new CliError(SERVER_START_USAGE);
      }
      parentPid = value;
      index += 1;
    } else {
      throw new CliError(SERVER_START_USAGE);
    }
  }
  return { background, tailscale, tailscaleOptional, noTailscale, port, parentPid };
}

async function handleRequest(
  originalContext: ProjectContext | null,
  basePath: string,
  tailnet: DashboardTailnetRuntime,
  dashboardPort: number | null,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    applyCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (basePath !== "/" && requestUrl.pathname === basePath.slice(0, -1)) {
      response.writeHead(302, { location: basePath });
      response.end();
      return;
    }
    if (!requestUrl.pathname.startsWith(basePath)) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const route = `/${requestUrl.pathname.slice(basePath.length)}`.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && route === "/") {
      sendDashboardAsset(response, "index.html");
    } else if (request.method === "GET" && route.startsWith("/assets/")) {
      sendDashboardAsset(response, route.slice(1));
    } else if (request.method === "GET" && route === "/api/state") {
      sendJson(response, 200, await dashboardState(originalContext, tailnet.state));
    } else if (request.method === "GET" && route === "/api/health") {
      sendJson(response, 200, { ok: true, service: "livetree", pid: process.pid });
    } else if (request.method === "GET" && route === "/api/logs") {
      streamServerLogs(originalContext, requestUrl, request, response);
    } else if (request.method === "POST" && route === "/api/tailnet/start") {
      if (dashboardPort === null) throw new CliError("The dashboard is not ready to start Tailscale Serve.");
      await startDashboardTailnet(tailnet, dashboardPort);
      sendJson(response, 200, { ok: true, tailnet: tailnet.state });
    } else if (request.method === "POST" && route.startsWith("/api/")) {
      const result = await handleAction(originalContext, route, await readJsonBody(request));
      sendJson(response, 200, { ok: true, ...result });
    } else {
      sendJson(response, 404, { error: "Not found" });
    }
  } catch (error) {
    sendJson(response, error instanceof CliError ? 400 : 500, { error: errorMessage(error) });
  }
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (!origin || !isTrustedAppOrigin(origin)) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("vary", "Origin");
}

function isTrustedAppOrigin(origin: string): boolean {
  if (["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"].includes(origin)) return true;
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function streamServerLogs(
  originalContext: ProjectContext | null,
  requestUrl: URL,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const { context, config } = requireDashboardProject(originalContext, requestUrl.searchParams.get("project"));
  const worktree = requireWorktree(context, requestUrl.searchParams.get("worktree"));
  const script = requireScript(config, requestUrl.searchParams.get("script"));
  const name = portlessName(config.name, worktree, script);
  const server = readServerEntry(context.stateDir, name);
  if (!server) throw new CliError(`Dev script '${script}' is not running in this worktree.`);
  if (!server.logPath) throw new CliError(`Logs are unavailable for this '${script}' process. Restart it with this version of livetree to enable capture.`);

  let offset: number;
  try {
    const size = statSync(server.logPath).size;
    offset = Math.max(0, size - MAX_INITIAL_LOG_BYTES);
  } catch {
    offset = 0;
  }

  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.flushHeaders();

  let reading = false;
  const pump = (): void => {
    if (reading || response.destroyed) return;
    let size: number;
    try {
      size = statSync(server.logPath!).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0;
    if (size === offset) return;

    const start = offset;
    offset = size;
    reading = true;
    const stream = createReadStream(server.logPath!, { start, end: size - 1 });
    stream.on("data", (chunk) => response.write(chunk));
    stream.once("end", () => { reading = false; });
    stream.once("error", () => { reading = false; });
  };

  pump();
  const timer = setInterval(pump, 250);
  request.once("close", () => clearInterval(timer));
}

async function dashboardState(originalContext: ProjectContext | null, tailnet: DashboardTailnetState): Promise<object> {
  const projects = await Promise.all(dashboardProjects(originalContext).map(dashboardProjectState));
  return { generatedAtMs: Date.now(), tailnet, projects };
}

async function dashboardProjectState(project: DashboardProject): Promise<object> {
  const { id, context, config } = project;
  const proxy = proxyInfo();
  const servers = readServerEntries(context.stateDir);
  const tunnels = new Map(readTunnelEntries(context.stateDir).map((entry) => [entry.name, entry]));
  const health = new Map<string, boolean>();
  await Promise.all(servers.map(async (server) => health.set(server.name, await probeAppReachable(server.name, proxy))));

  const worktrees = worktreesModifiedNewestFirst(context.choices).map(({ choice, modifiedAtMs }) => {
    const scripts = Object.keys(config.devScripts).sort().map((script) => {
      const name = portlessName(config.name, choice, script);
      const server = servers.find((entry) => entry.name === name) ?? null;
      const tunnel = tunnels.get(name) ?? null;
      return {
        script,
        name,
        url: urlForName(name, proxy),
        running: Boolean(server),
        healthy: server ? (health.get(name) ?? false) : false,
        pid: server?.pid ?? null,
        startedAtMs: server?.startedAtMs ?? null,
        managed: server?.managed ?? false,
        logPath: server?.logPath ?? null,
        tunnelUrl: tunnel?.url ?? null,
      };
    });
    const links = Object.entries(config.links).map(([name, template]) => {
      try {
        const url = interpolateTemplate(template, linkResolver(context, config, choice));
        return { name, url, available: true, qr: qrSvg(url) };
      } catch (error) {
        return { name, url: null, available: false, error: errorMessage(error), qr: null };
      }
    });
    return {
      path: choice.path,
      branch: choice.branch,
      ref: choice.ref,
      label: choice.label,
      chat: choice.isMain || !choice.chat ? null : {
        provider: choice.chat.provider,
        title: choice.chat.title,
      },
      isMain: choice.isMain,
      modifiedAtMs,
      scripts,
      links,
    };
  });
  return { id, name: config.name, path: context.mainRoot, worktrees };
}

function dashboardProjects(_originalContext: ProjectContext | null): DashboardProject[] {
  const projects: DashboardProject[] = [];
  const seen = new Set<string>();

  for (const projectPath of registeredProjectPaths()) {
    try {
      const context = buildProjectContext(projectPath);
      if (seen.has(context.mainRoot)) continue;
      const config = readLtConfig(context);
      seen.add(context.mainRoot);
      projects.push({ id: context.mainRoot, context, config });
    } catch {}
  }

  return projects;
}

function requireDashboardProject(originalContext: ProjectContext | null, value: unknown): DashboardProject {
  const projects = dashboardProjects(originalContext);
  if (value === null || value === undefined || value === "") {
    const project = projects[0];
    if (!project) throw new CliError("No LiveTree projects are saved.");
    return project;
  }
  if (typeof value !== "string") throw new CliError("Dashboard request requires a project id.");
  const project = projects.find((candidate) => candidate.id === value);
  if (!project) throw new CliError(`Unknown project: ${value}`);
  return project;
}

function linkResolver(context: ProjectContext, config: LtConfig, worktree: WorktreeChoice) {
  const proxy = proxyInfo();
  return {
    urlForScript: (script: string): string => {
      requireScript(config, script);
      return urlForName(portlessName(config.name, worktree, script), proxy);
    },
    tunnelUrlForScript: (script: string): string => {
      requireScript(config, script);
      const tunnel = readTunnelEntry(context.stateDir, portlessName(config.name, worktree, script));
      if (!tunnel) throw new CliError(`No tunnel is running for '${script}' in this worktree.`);
      return tunnel.url;
    },
  };
}

async function handleAction(originalContext: ProjectContext | null, route: string, body: ActionBody): Promise<object> {
  if (route === "/api/projects/add") {
    if (typeof body.path !== "string" || !body.path.trim()) {
      throw new CliError("Choose a project folder to add.");
    }
    const context = buildProjectContext(body.path.trim());
    readLtConfig(context);
    registerProject(context.mainRoot);
    return { project: context.mainRoot };
  }

  if (route === "/api/projects/remove") {
    const { id } = requireDashboardProject(originalContext, body.project);
    unregisterProject(id);
    return {};
  }

  const { context, config } = requireDashboardProject(originalContext, body.project);
  const refreshed = buildProjectContext(context.currentRoot);
  const worktree = requireWorktree(refreshed, body.worktree);

  if (route === "/api/worktrees/remove") {
    if (worktree.isMain) throw new CliError("The main worktree cannot be removed.");
    await gitAsync(
      ["worktree", "remove", ...(body.force === true ? ["--force"] : []), worktree.path],
      refreshed.mainRoot,
      `Could not remove '${worktree.label}'. Unlock it and try again.`,
    );
    await reconcileManagedProcesses(buildProjectContext(refreshed.mainRoot), config);
    return {};
  }

  const script = requireScript(config, body.script);
  const name = portlessName(config.name, worktree, script);

  if (route === "/api/dev/start") {
    if (!readServerEntry(refreshed.stateDir, name)) {
      await startDevProcess(refreshed, config, worktree, script, { proxy: await ensureProxyRunning(), managed: true });
    }
  } else if (route === "/api/dev/stop") {
    const tunnel = readTunnelEntry(refreshed.stateDir, name);
    if (tunnel) {
      await stopProcessGroupAndWait(tunnel.pid);
      removeTunnelEntry(refreshed.stateDir, name);
    }
    const entry = readServerEntry(refreshed.stateDir, name);
    if (entry) {
      await stopProcessGroupAndWait(entry.pid);
      removeServerEntry(refreshed.stateDir, name);
    }
    clearTunnelEnvPending(refreshed.stateDir, name);
  } else if (route === "/api/tunnel/start") {
    await ensureTunnelForScript(refreshed, config, worktree, script, {
      tailscale: readTailscaleInfo(),
      proxy: await ensureProxyRunning(),
      detached: true,
      created: [],
      log: (message) => console.error(message),
    });
  } else if (route === "/api/tunnel/stop") {
    const entry = readTunnelEntry(refreshed.stateDir, name);
    if (entry) {
      await stopProcessGroupAndWait(entry.pid);
      removeTunnelEntry(refreshed.stateDir, name);
      clearTunnelEnvPending(refreshed.stateDir, name);
    }
  } else {
    throw new CliError("Unknown dashboard action.");
  }
  return {};
}

function requireWorktree(context: ProjectContext, value: unknown): WorktreeChoice {
  if (typeof value !== "string") throw new CliError("Dashboard action requires a worktree path.");
  const worktree = context.choices.find((choice) => choice.path === value);
  if (!worktree) throw new CliError(`Unknown worktree: ${value}`);
  return worktree;
}

function requireScript(config: LtConfig, value: unknown): string {
  if (typeof value !== "string" || !config.devScripts[value]) throw new CliError(`Unknown dev script: ${String(value ?? "")}`);
  return value;
}

function readJsonBody(request: IncomingMessage): Promise<ActionBody> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) reject(new CliError("Request body is too large."));
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        resolve(parsed as ActionBody);
      } catch {
        reject(new CliError("Request body must be a JSON object."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: object): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendDashboardAsset(response: ServerResponse, relativePath: string): void {
  const dashboardRoot = path.resolve(fileURLToPath(new URL("../dashboard/", import.meta.url)));
  const filePath = path.resolve(dashboardRoot, relativePath);
  if (!filePath.startsWith(`${dashboardRoot}${path.sep}`)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    sendJson(response, 404, { error: "Dashboard asset not found. Run 'npm run build'." });
    return;
  }

  const extension = path.extname(filePath);
  const contentType = extension === ".html" ? "text/html; charset=utf-8"
    : extension === ".js" ? "text/javascript; charset=utf-8"
      : extension === ".css" ? "text/css; charset=utf-8"
        : "application/octet-stream";
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": size,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  });
  createReadStream(filePath).pipe(response);
}

function waitForShutdown(
  server: ReturnType<typeof createServer>,
  tailnet: DashboardTailnetRuntime,
  parentPid: number | null = null,
  onShutdown: () => void = () => {},
): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    const parentTimer = parentPid === null ? null : setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        stop();
      }
    }, 1_000);
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      tailnet.stopping = true;
      if (parentTimer) clearInterval(parentTimer);
      if (tailnet.child?.pid) {
        try { process.kill(-tailnet.child.pid, "SIGTERM"); } catch { try { process.kill(tailnet.child.pid, "SIGTERM"); } catch { /* gone */ } }
      }
      server.close(() => {
        onShutdown();
        resolve();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
