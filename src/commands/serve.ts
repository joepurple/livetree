import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readLtConfig } from "../config.js";
import { CliError, errorMessage } from "../errors.js";
import { interpolateTemplate } from "../interpolate.js";
import { portlessName } from "../naming.js";
import { ensureProxyRunning, probeAppReachable, proxyInfo, urlForName } from "../portless.js";
import { stopProcessGroupAndWait } from "../processes.js";
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

type ActionBody = { worktree?: unknown; script?: unknown };

export async function runServeCommand(context: ProjectContext, args: string[]): Promise<void> {
  const options = parseServeArgs(args);
  const config = readLtConfig(context);
  const basePath = "/";
  const server = createServer((request, response) => {
    void handleRequest(context, config, basePath, request, response);
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
  config: LtConfig,
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
      sendHtml(response, dashboardHtml(basePath));
    } else if (request.method === "GET" && route === "/api/state") {
      sendJson(response, 200, await dashboardState(originalContext, config));
    } else if (request.method === "POST" && route.startsWith("/api/")) {
      await handleAction(originalContext, config, route, await readJsonBody(request));
      sendJson(response, 200, { ok: true });
    } else {
      sendJson(response, 404, { error: "Not found" });
    }
  } catch (error) {
    sendJson(response, error instanceof CliError ? 400 : 500, { error: errorMessage(error) });
  }
}

async function dashboardState(originalContext: ProjectContext, config: LtConfig): Promise<object> {
  const context = buildProjectContext(originalContext.currentRoot);
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
      isMain: choice.isMain,
      modifiedAtMs,
      scripts,
      links,
    };
  });
  return { project: config.name, generatedAtMs: Date.now(), worktrees };
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

async function handleAction(context: ProjectContext, config: LtConfig, route: string, body: ActionBody): Promise<void> {
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

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  });
  response.end(html);
}

function dashboardHtml(basePath: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>livetree</title><style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#111;color:#eee}body{max-width:1100px;margin:0 auto;padding:28px 18px}h1{margin:0 0 6px}.muted{color:#999}.tree{border:1px solid #333;border-radius:12px;padding:16px;margin:18px 0;background:#181818}.path{overflow-wrap:anywhere}.script{display:grid;grid-template-columns:minmax(100px,1fr) minmax(220px,3fr) auto;gap:10px;align-items:center;border-top:1px solid #292929;padding:10px 0}.ok{color:#6dce8b}.bad{color:#f3a36b}button{border:1px solid #555;border-radius:7px;background:#242424;color:#fff;padding:6px 10px;cursor:pointer}.actions{display:flex;gap:6px;flex-wrap:wrap}.links{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px}.link{padding:10px;background:#202020;border-radius:8px}.link img{display:block;width:110px;height:110px;margin-top:8px}a{color:#8cc8ff;overflow-wrap:anywhere}@media(max-width:700px){.script{grid-template-columns:1fr}}
</style></head><body><h1>livetree</h1><div id="summary" class="muted">Loading…</div><main id="app"></main><script>
const base=${JSON.stringify(basePath)};const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const age=t=>{const s=Math.max(0,Math.floor((Date.now()-t)/1000));return s<60?s+'s':s<3600?Math.floor(s/60)+'m':s<86400?Math.floor(s/3600)+'h':Math.floor(s/86400)+'d'};
async function action(kind,w,s){const r=await fetch(base+'api/'+kind,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({worktree:w,script:s})});const x=await r.json();if(!r.ok)alert(x.error||'Action failed');await load()}
function buttons(w,s){let x='<button data-k="dev/'+(s.running?'stop':'start')+'">'+(s.running?'Stop':'Start')+'</button>';if(s.running)x+='<button data-k="tunnel/'+(s.tunnelUrl?'stop':'start')+'">'+(s.tunnelUrl?'Stop Tailscale':'Share via Tailscale')+'</button>';return '<span class="actions" data-w="'+esc(w.path)+'" data-s="'+esc(s.script)+'">'+x+'</span>'}
function render(d){document.querySelector('#summary').textContent=d.project+' · '+d.worktrees.length+' worktrees';document.querySelector('#app').innerHTML=d.worktrees.map(w=>'<section class="tree"><h2>'+esc(w.label)+' <small class="muted">'+age(w.modifiedAtMs)+'</small></h2>'+(w.isMain?'':'<div class="path muted">'+esc(w.path)+'</div>')+'<h3>Servers</h3>'+w.scripts.map(s=>'<div class="script"><strong>'+esc(s.script)+'</strong><div><a href="'+esc(s.url)+'" target="_blank">'+esc(s.url)+'</a><div class="'+(s.healthy?'ok':'bad')+'">'+(s.running?((s.healthy?'running':'running, not responding')+' · up '+age(s.startedAtMs)):'stopped')+(s.tunnelUrl?' · <a href="'+esc(s.tunnelUrl)+'" target="_blank">'+esc(s.tunnelUrl)+'</a>':'')+'</div></div>'+buttons(w,s)+'</div>').join('')+(w.links.length?'<h3>Links</h3><div class="links">'+w.links.map(l=>l.available?'<div class="link"><a href="'+esc(l.url)+'">'+esc(l.name)+'</a><img alt="QR" src="data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(l.qr)))+'"></div>':'<div class="link"><strong>'+esc(l.name)+'</strong><div class="muted">'+esc(l.error)+'</div></div>').join('')+'</div>':'')+'</section>').join('');document.querySelectorAll('button[data-k]').forEach(b=>b.onclick=()=>{const p=b.closest('[data-w]');void action(b.dataset.k,p.dataset.w,p.dataset.s)})}
async function load(){try{const r=await fetch(base+'api/state',{cache:'no-store'});const x=await r.json();if(!r.ok)throw new Error(x.error);render(x)}catch(e){document.querySelector('#summary').textContent='Error: '+e.message}}void load();setInterval(load,5000);
</script></body></html>`;
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
