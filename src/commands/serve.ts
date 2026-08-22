import type { ChildProcess } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLtConfig } from "../config.js";
import { CliError, errorMessage } from "../errors.js";
import { interpolateTemplate } from "../interpolate.js";
import { portlessName } from "../naming.js";
import { ensureProxyRunning, probeAppReachable, proxyInfo, urlForName } from "../portless.js";
import { stopProcessGroupAndWait } from "../processes.js";
import { isConfiguredProject, registeredProjectPaths } from "../projects.js";
import { qrSvg, qrTerminal } from "../qr.js";
import {
  clearTunnelEnvPending,
  readServerEntries,
  readServerEntry,
  readTunnelEntries,
  readTunnelEntry,
  removeServerEntry,
  removeTunnelEntry,
} from "../registry.js";
import { nextTailscaleServePort, readTailscaleInfo, startTailscaleServe, tailscaleUrl, usedTailscaleServePorts, waitForTailscaleServe } from "../tailscale.js";
import type { LtConfig, ProjectContext, WorktreeChoice } from "../types.js";
import { buildProjectContext, worktreesModifiedNewestFirst } from "../worktrees.js";
import { startDevProcess } from "./dev.js";
import { ensureTunnelForScript } from "./tunnel.js";

const DEFAULT_PORT = 43117;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_INITIAL_LOG_BYTES = 256 * 1024;

type ActionBody = { project?: unknown; worktree?: unknown; script?: unknown };

type DashboardProject = {
  id: string;
  context: ProjectContext;
  config: LtConfig;
};

export function resolveServeContext(cwd: string): ProjectContext {
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

  throw new CliError(
    "No saved livetree projects are available. Run a livetree command inside a Git worktree with a .ltconf first.",
  );
}

export async function runServeCommand(context: ProjectContext, args: string[]): Promise<void> {
  const options = parseServeArgs(args);
  const config = readLtConfig(context);
  await reconcileManagedProcesses(context, config);
  const basePath = "/";
  const server = createServer((request, response) => {
    void handleRequest(context, basePath, request, response);
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
  console.log(`Dashboard: ${localUrl}`);

  let tailscaleChild: ChildProcess | null = null;
  if (options.tailscale) {
    const tailscale = readTailscaleInfo();
    const httpsPort = nextTailscaleServePort(usedTailscaleServePorts(tailscale.binPath));
    const handle = startTailscaleServe(tailscale, address.port, httpsPort);
    tailscaleChild = handle.child;
    const tailnetUrl = tailscaleUrl(tailscale, httpsPort);
    try {
      await waitForTailscaleServe(handle, tailnetUrl);
    } catch (error) {
      if (handle.child.pid) await stopProcessGroupAndWait(handle.child.pid);
      server.close();
      throw error;
    }
    console.log(`Tailnet dashboard: ${tailnetUrl}`);
    console.log(qrTerminal(tailnetUrl));
  }

  console.error("Press Ctrl-C to stop.");
  await waitForShutdown(server, tailscaleChild);
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

function parseServeArgs(args: string[]): { tailscale: boolean; port: number } {
  let tailscale = false;
  let port = DEFAULT_PORT;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tailscale") {
      tailscale = true;
    } else if (arg === "--port") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new CliError("Usage: livetree serve [--tailscale] [--port <number>]");
      }
      port = value;
      index += 1;
    } else {
      throw new CliError("Usage: livetree serve [--tailscale] [--port <number>]");
    }
  }
  return { tailscale, port };
}

async function handleRequest(
  originalContext: ProjectContext,
  basePath: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
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
      sendJson(response, 200, await dashboardState(originalContext));
    } else if (request.method === "GET" && route === "/api/logs") {
      streamServerLogs(originalContext, requestUrl, request, response);
    } else if (request.method === "POST" && route.startsWith("/api/")) {
      await handleAction(originalContext, route, await readJsonBody(request));
      sendJson(response, 200, { ok: true });
    } else {
      sendJson(response, 404, { error: "Not found" });
    }
  } catch (error) {
    sendJson(response, error instanceof CliError ? 400 : 500, { error: errorMessage(error) });
  }
}

function streamServerLogs(
  originalContext: ProjectContext,
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

async function dashboardState(originalContext: ProjectContext): Promise<object> {
  const projects = await Promise.all(dashboardProjects(originalContext).map(dashboardProjectState));
  return { generatedAtMs: Date.now(), projects };
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

function dashboardProjects(originalContext: ProjectContext): DashboardProject[] {
  const projects: DashboardProject[] = [];
  const seen = new Set<string>();

  for (const projectPath of [originalContext.mainRoot, ...registeredProjectPaths()]) {
    try {
      const context = buildProjectContext(projectPath);
      if (seen.has(context.mainRoot)) continue;
      const config = readLtConfig(context);
      seen.add(context.mainRoot);
      projects.push({ id: context.mainRoot, context, config });
    } catch (error) {
      if (projectPath === originalContext.mainRoot) throw error;
    }
  }

  return projects;
}

function requireDashboardProject(originalContext: ProjectContext, value: unknown): DashboardProject {
  const projects = dashboardProjects(originalContext);
  if (value === null || value === undefined || value === "") return projects[0]!;
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

async function handleAction(originalContext: ProjectContext, route: string, body: ActionBody): Promise<void> {
  const { context, config } = requireDashboardProject(originalContext, body.project);
  const refreshed = buildProjectContext(context.currentRoot);
  const worktree = requireWorktree(refreshed, body.worktree);
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

function waitForShutdown(server: ReturnType<typeof createServer>, tailscaleChild: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      if (tailscaleChild?.pid) {
        try { process.kill(-tailscaleChild.pid, "SIGTERM"); } catch { try { process.kill(tailscaleChild.pid, "SIGTERM"); } catch { /* gone */ } }
      }
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
