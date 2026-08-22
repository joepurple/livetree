import {
  Activity, ArrowUpRight, ChevronRight, Clock, ExternalLink, FolderGit2, GitBranch,
  Globe2, Link2, LoaderCircle, Play, RefreshCw, Search, Server, Share2, Square,
  Terminal as TerminalIcon, TreePine, Wifi,
} from "lucide-solid";
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { TerminalPane } from "./TerminalPane";
import type { DashboardState, LogSelection, Script, Worktree } from "./types";

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

export default function App() {
  const [state, setState] = createSignal<DashboardState>();
  const [selectedPath, setSelectedPath] = createSignal<string>();
  const [query, setQuery] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal<string>();
  const [logs, setLogs] = createSignal<LogSelection>();
  const [refreshing, setRefreshing] = createSignal(false);

  const selectedWorktree = createMemo(() => {
    const current = state();
    return current?.worktrees.find((worktree) => worktree.path === selectedPath()) ?? current?.worktrees[0];
  });
  const filteredWorktrees = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return state()?.worktrees ?? [];
    return (state()?.worktrees ?? []).filter((worktree) =>
      [worktree.label, worktree.branch, worktree.path].some((value) => value?.toLowerCase().includes(needle)),
    );
  });
  const runningCount = createMemo(() => state()?.worktrees.flatMap((tree) => tree.scripts).filter((script) => script.running).length ?? 0);
  const healthyCount = createMemo(() => state()?.worktrees.flatMap((tree) => tree.scripts).filter((script) => script.healthy).length ?? 0);

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
    onCleanup(() => window.clearInterval(timer));
  });

  return (
    <div class="app-shell">
      <aside class="project-rail">
        <div class="brand"><span class="brand__mark"><TreePine size={19} /></span><span>livetree</span></div>
        <div class="rail-label">Projects</div>
        <Show when={state()} fallback={<div class="project-skeleton" />}>
          {(current) => (
            <button class="project-item project-item--active" type="button">
              <span class="project-item__icon"><FolderGit2 size={18} /></span>
              <span class="project-item__copy"><strong>{current().project}</strong><small>{current().worktrees.length} worktrees</small></span>
              <span class="project-item__count">{runningCount()}</span>
            </button>
          )}
        </Show>
        <div class="project-rail__footer"><span class="pulse-dot" />Local daemon</div>
      </aside>

      <aside class="worktree-rail">
        <header class="worktree-rail__header">
          <div><span class="eyebrow">Workspace</span><h1>{state()?.project ?? "Loading"}</h1></div>
          <Button size="icon" variant="ghost" aria-label="Refresh dashboard" onClick={() => void load(true)}>
            <RefreshCw size={16} classList={{ spin: refreshing() }} />
          </Button>
        </header>
        <label class="search-field">
          <Search size={15} />
          <input value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Filter worktrees…" aria-label="Filter worktrees" />
        </label>
        <div class="worktree-list" aria-label="Worktrees">
          <For each={filteredWorktrees()}>
            {(worktree) => {
              const running = () => worktree.scripts.filter((script) => script.running).length;
              return (
                <button type="button" class="worktree-item" classList={{ "worktree-item--active": selectedWorktree()?.path === worktree.path }} onClick={() => setSelectedPath(worktree.path)}>
                  <span class="worktree-item__glyph"><GitBranch size={16} /></span>
                  <span class="worktree-item__copy">
                    <span><strong>{worktree.label}</strong>{worktree.isMain && <Badge tone="info">main</Badge>}</span>
                    <small>{running() ? `${running()} server${running() === 1 ? "" : "s"} running` : `Updated ${age(worktree.modifiedAtMs)} ago`}</small>
                  </span>
                  <ChevronRight size={15} class="worktree-item__chevron" />
                </button>
              );
            }}
          </For>
          <Show when={filteredWorktrees().length === 0}><div class="empty-filter">No matching worktrees</div></Show>
        </div>
      </aside>

      <main class="workspace">
        <Show when={error()}>{(message) => <div class="error-banner" role="alert"><strong>Something went wrong</strong><span>{message()}</span><Button size="sm" onClick={() => void load(true)}>Try again</Button></div>}</Show>
        <Show when={selectedWorktree()} fallback={<LoadingState />}>
          {(worktree) => <WorktreeView worktree={worktree()} busy={busy()} onAction={action} onLogs={(script) => setLogs({ worktree: worktree(), script })} totalHealthy={healthyCount()} totalRunning={runningCount()} />}
        </Show>
      </main>
      <Show when={logs()}>{(selection) => <TerminalPane selection={selection()} onClose={() => setLogs(undefined)} />}</Show>
    </div>
  );
}

function LoadingState() {
  return <div class="loading-state"><LoaderCircle class="spin" size={22} /><span>Loading your worktrees</span></div>;
}

function WorktreeView(props: {
  worktree: Worktree;
  busy?: string;
  totalHealthy: number;
  totalRunning: number;
  onAction: (kind: string, worktree: Worktree, script: Script) => Promise<void>;
  onLogs: (script: Script) => void;
}) {
  const running = () => props.worktree.scripts.filter((script) => script.running).length;
  const isBusy = (kind: string, script: Script) => props.busy === `${props.worktree.path}:${script.script}:${kind}`;
  return (
    <div class="workspace__inner">
      <header class="workspace-header">
        <div>
          <div class="breadcrumb"><span>{props.worktree.isMain ? "Primary worktree" : "Linked worktree"}</span><ChevronRight size={13} /><span>{props.worktree.branch ?? props.worktree.ref ?? "detached"}</span></div>
          <h2>{props.worktree.label}</h2>
          <div class="workspace-path" title={props.worktree.path}>{shortPath(props.worktree.path)}</div>
        </div>
        <div class="workspace-health"><span class="pulse-dot" /><span><strong>{props.totalHealthy}/{props.totalRunning}</strong> healthy across project</span></div>
      </header>

      <div class="metrics">
        <Metric icon={<Server size={17} />} label="Servers" value={`${running()} / ${props.worktree.scripts.length}`} detail="running" />
        <Metric icon={<Activity size={17} />} label="Health" value={`${props.worktree.scripts.filter((script) => script.healthy).length}`} detail="responding" />
        <Metric icon={<Link2 size={17} />} label="Links" value={`${props.worktree.links.filter((link) => link.available).length}`} detail="available" />
        <Metric icon={<Clock size={17} />} label="Updated" value={age(props.worktree.modifiedAtMs)} detail="ago" />
      </div>

      <section class="section-block">
        <div class="section-heading"><div><span class="eyebrow">Runtime</span><h3>Development servers</h3></div><span>{props.worktree.scripts.length} configured</span></div>
        <div class="server-list">
          <For each={props.worktree.scripts} fallback={<EmptyState icon={<Server size={20} />} title="No servers configured" copy="Add a dev script to .ltconf to see it here." />}>
            {(script) => (
              <Card class="server-card">
                <div class="server-card__identity">
                  <span class="server-icon" classList={{ "server-icon--running": script.running }}><Server size={18} /></span>
                  <div><div class="server-name"><strong>{script.script}</strong><Badge tone={script.healthy ? "success" : script.running ? "warning" : "neutral"}>{script.healthy ? "healthy" : script.running ? "starting" : "stopped"}</Badge></div><span>{script.name}</span></div>
                </div>
                <div class="server-card__address">
                  <a href={script.url} target="_blank" rel="noreferrer">{script.url}<ArrowUpRight size={13} /></a>
                  <span>{script.running ? `PID ${script.pid} · up ${age(script.startedAtMs)}` : "Ready to start"}</span>
                </div>
                <div class="server-card__actions">
                  <Show when={script.running && script.logPath}><Button size="sm" variant="ghost" onClick={() => props.onLogs(script)}><TerminalIcon size={15} />Logs</Button></Show>
                  <Button size="sm" variant={script.running ? "danger" : "primary"} disabled={Boolean(props.busy)} onClick={() => void props.onAction(`dev/${script.running ? "stop" : "start"}`, props.worktree, script)}>
                    {isBusy(`dev/${script.running ? "stop" : "start"}`, script) ? <LoaderCircle class="spin" size={15} /> : script.running ? <Square size={13} /> : <Play size={14} />}{script.running ? "Stop" : "Start"}
                  </Button>
                  <Show when={script.running}>
                    <Button size="sm" variant="outline" disabled={Boolean(props.busy)} onClick={() => void props.onAction(`tunnel/${script.tunnelUrl ? "stop" : "start"}`, props.worktree, script)}>
                      {isBusy(`tunnel/${script.tunnelUrl ? "stop" : "start"}`, script) ? <LoaderCircle class="spin" size={15} /> : <Share2 size={14} />}{script.tunnelUrl ? "Unshare" : "Share"}
                    </Button>
                  </Show>
                </div>
                <Show when={script.tunnelUrl}><a class="tunnel-row" href={script.tunnelUrl!} target="_blank" rel="noreferrer"><Wifi size={14} /><span>Tailscale</span><code>{script.tunnelUrl}</code><ExternalLink size={13} /></a></Show>
              </Card>
            )}
          </For>
        </div>
      </section>

      <section class="section-block links-section">
        <div class="section-heading"><div><span class="eyebrow">Shortcuts</span><h3>Project links</h3></div></div>
        <div class="link-grid">
          <For each={props.worktree.links} fallback={<EmptyState icon={<Link2 size={20} />} title="No links configured" copy="Configured links for this worktree will appear here." />}>
            {(link) => (
              <Card class="link-card">
                <div class="link-card__top"><span class="link-icon"><Globe2 size={17} /></span><Badge tone={link.available ? "success" : "warning"}>{link.available ? "available" : "unavailable"}</Badge></div>
                <strong>{link.name}</strong>
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

function Metric(props: { icon: JSX.Element; label: string; value: string; detail: string }) {
  return <div class="metric"><span class="metric__icon">{props.icon}</span><div><span>{props.label}</span><strong>{props.value} <small>{props.detail}</small></strong></div></div>;
}

function EmptyState(props: { icon: JSX.Element; title: string; copy: string }) {
  return <div class="empty-state"><span>{props.icon}</span><strong>{props.title}</strong><small>{props.copy}</small></div>;
}
