import {
  ArrowUpRight, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, FolderGit2, Link2,
  LoaderCircle, PanelLeftClose, PanelLeftOpen, Play, RadioTower, RefreshCw,
  Server, Square, Terminal as TerminalIcon, TreePine, Wifi,
} from "lucide-solid";
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { TerminalPage } from "./TerminalPage";
import type { DashboardState, LogSelection, Script, Worktree } from "./types";

type MobileView = "projects" | "worktrees" | "workspace";

function age(timestamp: number | null): string {
  if (!timestamp) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function shortPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : value;
}

function apiUrl(route: string): URL {
  return new URL(`api/${route}`, document.baseURI);
}

function worktreeTitle(worktree: Worktree): string {
  if (worktree.isMain) return "main";
  return worktree.chat?.title ?? worktree.ref ?? worktree.path.split("/").filter(Boolean).at(-1) ?? "worktree";
}

function branchTitle(worktree: Worktree): string {
  return worktree.branch ?? worktree.ref ?? "detached";
}

function storedBoolean(key: string): boolean {
  try { return window.localStorage.getItem(key) === "true"; } catch { return false; }
}

function storedWidth(key: string, fallback: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  let dashboardScrollY = 0;
  const [state, setState] = createSignal<DashboardState>();
  const [selectedPath, setSelectedPath] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal<string>();
  const [logs, setLogs] = createSignal<LogSelection>();
  const [refreshing, setRefreshing] = createSignal(false);
  const [projectCollapsed, setProjectCollapsed] = createSignal(storedBoolean("livetree.projectRailCollapsed"));
  const [worktreeCollapsed, setWorktreeCollapsed] = createSignal(storedBoolean("livetree.worktreeRailCollapsed"));
  const [projectWidth, setProjectWidth] = createSignal(storedWidth("livetree.projectRailWidth", 218));
  const [worktreeWidth, setWorktreeWidth] = createSignal(storedWidth("livetree.worktreeRailWidth", 294));
  const [terminalWidth, setTerminalWidth] = createSignal(storedWidth("livetree.terminalWidth", 440));
  const [mobileView, setMobileView] = createSignal<MobileView>("projects");

  const selectedWorktree = createMemo(() => {
    const current = state();
    return current?.worktrees.find((worktree) => worktree.path === selectedPath()) ?? current?.worktrees[0];
  });
  const filteredWorktrees = createMemo(() => state()?.worktrees ?? []);
  const runningCount = createMemo(() => state()?.worktrees.flatMap((tree) => tree.scripts).filter((script) => script.running).length ?? 0);

  async function load(showSpinner = false): Promise<void> {
    if (showSpinner) setRefreshing(true);
    try {
      const response = await fetch(apiUrl("state"), { cache: "no-store" });
      const payload = (await response.json()) as DashboardState & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to load livetree");
      setState(payload);
      if (!selectedPath() || !payload.worktrees.some((tree) => tree.path === selectedPath())) {
        setSelectedPath(payload.worktrees[0]?.path);
      }
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRefreshing(false);
    }
  }

  async function action(kind: string, worktree: Worktree, script: Script): Promise<void> {
    const key = `${worktree.path}:${script.script}:${kind}`;
    setBusy(key);
    try {
      const response = await fetch(apiUrl(kind), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktree: worktree.path, script: script.script }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Action failed");
      await load();
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  }

  onMount(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    const mobileQuery = window.matchMedia("(max-width: 820px)");
    if (mobileQuery.matches) {
      const initial = history.state?.livetreeMobileView;
      const view: MobileView = initial === "worktrees" || initial === "workspace" ? initial : "projects";
      setMobileView(view);
      history.replaceState({ ...history.state, livetreeMobileView: view }, "");
    }
    const onPopState = (event: PopStateEvent) => {
      const view = event.state?.livetreeMobileView;
      setMobileView(view === "worktrees" || view === "workspace" ? view : "projects");
    };
    window.addEventListener("popstate", onPopState);
    onCleanup(() => {
      window.clearInterval(timer);
      window.removeEventListener("popstate", onPopState);
    });
  });

  function navigateMobile(view: MobileView): void {
    setMobileView(view);
    if (window.matchMedia("(max-width: 820px)").matches) {
      history.pushState({ ...history.state, livetreeMobileView: view }, "");
    }
  }

  function backMobile(fallback: MobileView): void {
    if (window.matchMedia("(max-width: 820px)").matches && history.state?.livetreeMobileView === mobileView()) {
      history.back();
      return;
    }
    setMobileView(fallback);
  }

  function openLogs(worktree: Worktree, script: Script): void {
    dashboardScrollY = window.scrollY;
    setLogs({ worktree, script });
  }

  function closeLogs(): void {
    setLogs(undefined);
    requestAnimationFrame(() => window.scrollTo({ top: dashboardScrollY }));
  }

  function toggleRail(kind: "project" | "worktree"): void {
    if (kind === "project") {
      const next = !projectCollapsed();
      setProjectCollapsed(next);
      try { window.localStorage.setItem("livetree.projectRailCollapsed", String(next)); } catch {}
      return;
    }
    const next = !worktreeCollapsed();
    setWorktreeCollapsed(next);
    try { window.localStorage.setItem("livetree.worktreeRailCollapsed", String(next)); } catch {}
  }

  function beginResize(kind: "project" | "worktree", event: PointerEvent): void {
    if (window.matchMedia("(max-width: 820px)").matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = kind === "project" ? projectWidth() : worktreeWidth();
    const limits = kind === "project" ? [170, 340] : [220, 440];
    let currentWidth = startWidth;
    document.body.classList.add("is-resizing-rail");
    const move = (moveEvent: PointerEvent) => {
      currentWidth = Math.min(limits[1], Math.max(limits[0], startWidth + moveEvent.clientX - startX));
      if (kind === "project") setProjectWidth(currentWidth);
      else setWorktreeWidth(currentWidth);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("is-resizing-rail");
      try { window.localStorage.setItem(`livetree.${kind}RailWidth`, String(currentWidth)); } catch {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function beginTerminalResize(event: PointerEvent): void {
    if (window.matchMedia("(max-width: 1180px)").matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = terminalWidth();
    let currentWidth = startWidth;
    document.body.classList.add("is-resizing-rail");
    const move = (moveEvent: PointerEvent) => {
      currentWidth = Math.min(760, Math.max(360, startWidth - (moveEvent.clientX - startX)));
      setTerminalWidth(currentWidth);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("is-resizing-rail");
      try { window.localStorage.setItem("livetree.terminalWidth", String(currentWidth)); } catch {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  return (
    <div
      class="app-shell"
      classList={{
        "app-shell--project-collapsed": projectCollapsed(),
        "app-shell--worktree-collapsed": worktreeCollapsed(),
        "app-shell--terminal-open": Boolean(logs()),
        "mobile-view--projects": mobileView() === "projects",
        "mobile-view--worktrees": mobileView() === "worktrees",
        "mobile-view--workspace": mobileView() === "workspace",
      }}
      style={`--project-width:${projectWidth()}px;--worktree-width:${worktreeWidth()}px;--terminal-width:${terminalWidth()}px`}
    >
      <aside class="project-rail">
        <div class="project-rail__top">
          <div class="brand"><span class="brand__mark"><TreePine size={19} /></span><span class="brand__name">livetree</span></div>
          <Button size="icon" variant="ghost" class="rail-toggle" aria-label={projectCollapsed() ? "Expand projects sidebar" : "Collapse projects sidebar"} aria-expanded={!projectCollapsed()} onClick={() => toggleRail("project")}>
            {projectCollapsed() ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </Button>
        </div>
        <div class="rail-label">Projects</div>
        <Show when={state()} fallback={<div class="project-skeleton" />}>
          {(current) => (
            <button class="project-item project-item--active" type="button" onClick={() => navigateMobile("worktrees")}>
              <span class="project-item__icon"><FolderGit2 size={18} /></span>
              <span class="project-item__copy"><strong>{current().project}</strong><small>{current().worktrees.length} worktrees</small></span>
              <span class="project-item__count">{runningCount()}</span>
              <ChevronRight size={17} class="mobile-disclosure" />
            </button>
          )}
        </Show>
        <div class="project-rail__footer"><span class="pulse-dot" />Local daemon</div>
        <div class="rail-resizer" role="separator" aria-label="Resize projects sidebar" aria-orientation="vertical" aria-valuemin="170" aria-valuemax="340" aria-valuenow={projectWidth()} onPointerDown={(event) => beginResize("project", event)} />
      </aside>

      <aside class="worktree-rail">
        <div class="mobile-stack-header">
          <Button size="sm" variant="ghost" class="mobile-back" aria-label="Back to projects" onClick={() => backMobile("projects")}><ChevronLeft size={18} /><span>Projects</span></Button>
          <strong>{state()?.project ?? "Worktrees"}</strong>
          <Button size="icon" variant="ghost" aria-label="Refresh dashboard" onClick={() => void load(true)}><RefreshCw size={16} classList={{ spin: refreshing() }} /></Button>
        </div>
        <div class="mobile-screen-heading">Worktrees</div>
        <header class="worktree-rail__header">
          <div class="worktree-rail__title">
            <Show when={projectCollapsed()}><Button size="icon" variant="ghost" class="rail-expand" aria-label="Expand projects sidebar" onClick={() => toggleRail("project")}><PanelLeftOpen size={16} /></Button></Show>
            <h1>{state()?.project ?? "Loading"}</h1>
          </div>
          <div class="worktree-rail__controls">
            <Button size="icon" variant="ghost" class="refresh-button" aria-label="Refresh dashboard" onClick={() => void load(true)}>
              <RefreshCw size={16} classList={{ spin: refreshing() }} />
            </Button>
            <Button size="icon" variant="ghost" class="rail-toggle" aria-label={worktreeCollapsed() ? "Expand worktrees sidebar" : "Collapse worktrees sidebar"} aria-expanded={!worktreeCollapsed()} onClick={() => toggleRail("worktree")}>
              {worktreeCollapsed() ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </Button>
          </div>
        </header>
        <div class="worktree-list" aria-label="Worktrees">
          <For each={filteredWorktrees()}>
            {(worktree) => {
              return (
                <button type="button" class="worktree-item" classList={{ "worktree-item--active": selectedWorktree()?.path === worktree.path }} aria-label={`${worktreeTitle(worktree)}, branch ${branchTitle(worktree)}`} title={worktreeCollapsed() ? worktreeTitle(worktree) : undefined} onClick={() => { setSelectedPath(worktree.path); navigateMobile("workspace"); }}>
                  <span class="worktree-item__collapsed-mark">{worktree.isMain ? "M" : <Show when={worktree.chat}>{(chat) => <AgentIcon provider={chat().provider} />}</Show>}</span>
                  <span class="worktree-item__copy">
                    <span><Show when={worktree.chat}>{(chat) => <AgentIcon provider={chat().provider} />}</Show><strong>{worktreeTitle(worktree)}</strong></span>
                    <small class="worktree-item__branch"><b>Branch</b> {branchTitle(worktree)}</small>
                    <small>Updated {age(worktree.modifiedAtMs)} ago</small>
                  </span>
                  <ChevronRight size={17} class="mobile-disclosure" />
                </button>
              );
            }}
          </For>
          <Show when={filteredWorktrees().length === 0}><div class="empty-filter">No matching worktrees</div></Show>
        </div>
        <div class="rail-resizer" role="separator" aria-label="Resize worktrees sidebar" aria-orientation="vertical" aria-valuemin="220" aria-valuemax="440" aria-valuenow={worktreeWidth()} onPointerDown={(event) => beginResize("worktree", event)} />
      </aside>

      <main class="workspace">
        <div class="mobile-stack-header">
          <Button size="sm" variant="ghost" class="mobile-back" aria-label="Back to worktrees" onClick={() => backMobile("worktrees")}><ChevronLeft size={18} /><span>Worktrees</span></Button>
          <strong>{state()?.project ?? "livetree"}</strong>
          <span class="mobile-stack-header__spacer" />
        </div>
        <Show when={worktreeCollapsed() || (projectCollapsed() && worktreeCollapsed())}>
          <div class="workspace-rail-controls">
            <Show when={projectCollapsed() && worktreeCollapsed()}><Button size="icon" variant="ghost" aria-label="Expand projects sidebar" onClick={() => toggleRail("project")}><PanelLeftOpen size={16} /></Button></Show>
            <Show when={worktreeCollapsed()}><Button size="icon" variant="ghost" aria-label="Expand worktrees sidebar" onClick={() => toggleRail("worktree")}><PanelLeftOpen size={16} /></Button></Show>
          </div>
        </Show>
        <Show when={error()}>{(message) => <div class="error-banner" role="alert"><strong>Something went wrong</strong><span>{message()}</span><Button size="sm" onClick={() => void load(true)}>Try again</Button></div>}</Show>
        <Show when={selectedWorktree()} fallback={<LoadingState />}>
          {(worktree) => <WorktreeView projectName={state()?.project ?? ""} worktree={worktree()} busy={busy()} onAction={action} onLogs={(script) => openLogs(worktree(), script)} />}
        </Show>
      </main>
      <Show when={logs()}>{(selection) => <TerminalPage selection={selection()} onClose={closeLogs} onResizeStart={beginTerminalResize} width={terminalWidth()} />}</Show>
    </div>
  );
}

function LoadingState() {
  return <div class="loading-state"><LoaderCircle class="spin" size={22} /><span>Loading your worktrees</span></div>;
}

function WorktreeView(props: {
  projectName: string;
  worktree: Worktree;
  busy?: string;
  onAction: (kind: string, worktree: Worktree, script: Script) => Promise<void>;
  onLogs: (script: Script) => void;
}) {
  const [copiedPath, setCopiedPath] = createSignal<string>();
  let copiedTimer: number | undefined;
  const isBusy = (kind: string, script: Script) => props.busy === `${props.worktree.path}:${script.script}:${kind}`;

  async function copyPath(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.worktree.path);
    } catch {
      const input = document.createElement("textarea");
      input.value = props.worktree.path;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopiedPath(props.worktree.path);
    window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => setCopiedPath(undefined), 1_500);
  }

  onCleanup(() => window.clearTimeout(copiedTimer));

  return (
    <div class="workspace__inner">
      <header class="workspace-header">
        <div class="workspace-header__identity">
          <span class="workspace-project">{props.projectName}</span>
          <div class="workspace-title">
            <h2>{worktreeTitle(props.worktree)}</h2>
            <Show when={props.worktree.chat}>{(chat) => <AgentIcon provider={chat().provider} />}</Show>
          </div>
          <div class="workspace-meta">
            <div class="branch-line"><span>Branch</span><code>{branchTitle(props.worktree)}</code></div>
            <Show when={!props.worktree.isMain}>
              <button type="button" class="workspace-path" title={`Copy ${props.worktree.path}`} aria-label={`Copy worktree path ${props.worktree.path}`} onClick={() => void copyPath()}>
                <span>{shortPath(props.worktree.path)}</span>{copiedPath() === props.worktree.path ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </Show>
          </div>
        </div>
      </header>

      <section class="section-block">
        <div class="section-heading"><h3>Runtime</h3></div>
        <div class="server-list">
          <For each={props.worktree.scripts} fallback={<EmptyState icon={<Server size={20} />} title="No servers configured" copy="Add a dev script to .ltconf to see it here." />}>
            {(script) => (
              <Card class="server-card">
                <div class="server-card__identity">
                  <span class="server-icon" classList={{ "server-icon--running": script.running }}><Server size={18} /></span>
                  <div>
                    <div class="server-name">
                      <a href={script.url} target="_blank" rel="noreferrer" title={script.url}><span>{script.script}</span><ArrowUpRight size={13} /></a>
                      <Show when={script.tunnelUrl}><a class="server-tunnel-link" href={script.tunnelUrl!} target="_blank" rel="noreferrer" title={script.tunnelUrl!} aria-label={`Open ${script.script} Tailscale URL`}><Wifi size={13} /></a></Show>
                      <Badge tone={script.healthy ? "success" : script.running ? "warning" : "neutral"}>{script.healthy ? "healthy" : script.running ? "starting" : "stopped"}</Badge>
                    </div>
                    <span class="server-meta">{script.running ? `PID ${script.pid} · up ${age(script.startedAtMs)}` : "Ready to start"}</span>
                  </div>
                </div>
                <div class="server-card__actions">
                  <Button size="icon" variant={script.running ? "danger" : "primary"} aria-label={`${script.running ? "Stop" : "Start"} ${script.script}`} title={script.running ? "Stop" : "Start"} disabled={Boolean(props.busy)} onClick={() => void props.onAction(`dev/${script.running ? "stop" : "start"}`, props.worktree, script)}>
                    {isBusy(`dev/${script.running ? "stop" : "start"}`, script) ? <LoaderCircle class="spin" size={15} /> : script.running ? <Square size={13} /> : <Play size={14} />}
                  </Button>
                  <Show when={script.running}>
                    <Button size="icon" variant="outline" aria-label={`${script.tunnelUrl ? "Stop Tailscale" : "Start Tailscale"} for ${script.script}`} title={script.tunnelUrl ? "Stop Tailscale" : "Start Tailscale"} data-tooltip={script.tunnelUrl ? "Stop Tailscale" : "Start Tailscale"} disabled={Boolean(props.busy)} onClick={() => void props.onAction(`tunnel/${script.tunnelUrl ? "stop" : "start"}`, props.worktree, script)}>
                      {isBusy(`tunnel/${script.tunnelUrl ? "stop" : "start"}`, script) ? <LoaderCircle class="spin" size={15} /> : <RadioTower size={15} />}
                    </Button>
                  </Show>
                </div>
                <button type="button" class="server-card__logs" disabled={!script.running || !script.logPath} aria-label={script.running && script.logPath ? `Open ${script.script} logs in side pane` : `${script.script} logs unavailable`} title={script.running && script.logPath ? "Open logs" : "Logs unavailable"} onClick={() => props.onLogs(script)}><TerminalIcon size={15} /><ChevronRight size={14} /></button>
              </Card>
            )}
          </For>
        </div>
      </section>

      <section class="section-block links-section">
        <div class="section-heading"><h3>Shortcuts</h3></div>
        <div class="link-grid">
          <For each={props.worktree.links} fallback={<EmptyState icon={<Link2 size={20} />} title="No links configured" copy="Configured links for this worktree will appear here." />}>
            {(link) => (
              <Card class="link-card">
                <div class="link-card__heading"><strong>{link.name}</strong><Badge tone={link.available ? "success" : "warning"}>{link.available ? "available" : "unavailable"}</Badge></div>
                <Show when={link.available && link.url} fallback={<span class="link-card__error">{link.error}</span>}>
                  <a href={link.url!} target="_blank" rel="noreferrer"><span>{link.url}</span><ExternalLink size={14} /></a>
                </Show>
                <Show when={link.qr}><details class="qr-details"><summary>Show QR code</summary><img src={`data:image/svg+xml,${encodeURIComponent(link.qr!)}`} alt={`QR code for ${link.name}`} /></details></Show>
              </Card>
            )}
          </For>
        </div>
      </section>
    </div>
  );
}

function AgentIcon(props: { provider: "claude" | "codex" | "cursor" }) {
  const paths = {
    codex: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    cursor: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  };
  return (
    <span class="agent-icon" title={props.provider} aria-label={`${props.provider} chat`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[props.provider]} /></svg>
    </span>
  );
}

function EmptyState(props: { icon: JSX.Element; title: string; copy: string }) {
  return <div class="empty-state"><span>{props.icon}</span><strong>{props.title}</strong><small>{props.copy}</small></div>;
}
