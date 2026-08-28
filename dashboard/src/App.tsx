import {
  ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Folder, FolderGit2, Link2,
  LoaderCircle, PanelLeftClose, PanelLeftOpen, Play, Plus, RadioTower, RefreshCw,
  MonitorSmartphone, Server, Settings, Square, Terminal as TerminalIcon, Trash2, TreePine, TriangleAlert, Wifi, X,
} from "lucide-solid";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { connectionStatus, createPaneBackSwipeRecognizer, shouldUseSameViewLink, type ServerMode } from "../../src/desktop-ui.js";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { TerminalPage } from "./TerminalPage";
import { desktopUrlFromMobileAppLink } from "../../src/mobile-link";
import { apiUrl, bundledSettingsRequested, clearBundledSettingsRequest, connectedDashboardReturnUrl, loadServerDashboard, nativeLinkOpenerAvailable, normalizeDesktopUrl, openExternalUrl, persistDesktopUrl, pickProjectFolder, readNativeInfo, readPersistedDesktopUrl, runningInTauri, setApiBase, setMenuBarMode, type NativeInfo } from "./native";
import type { DashboardState, Link, LogSelection, Project, Script, Worktree } from "./types";

type MobileView = "worktrees" | "workspace";
type ActivityToast = {
  id: string;
  tone: "loading" | "success" | "error";
  title: string;
  message: string;
};

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

function worktreeTitle(worktree: Worktree): string {
  if (worktree.isMain) return "main";
  return worktree.chat?.title ?? worktree.ref ?? worktree.path.split("/").filter(Boolean).at(-1) ?? "worktree";
}

function branchTitle(worktree: Worktree): string {
  return worktree.branch ?? worktree.ref ?? "detached";
}

function openExternalLink(event: MouseEvent, url: string): void {
  const nativeBridge = nativeLinkOpenerAvailable();
  if (nativeBridge) {
    event.preventDefault();
    void openExternalUrl(url).catch((error) => console.error(`Unable to open ${url}`, error));
    return;
  }
  if (!shouldUseSameViewLink({ nativeBridge, mobileViewport: window.matchMedia("(max-width: 820px)").matches })) return;
  event.preventDefault();
  window.location.assign(url);
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

function storedString(key: string): string | undefined {
  try { return window.localStorage.getItem(key) ?? undefined; } catch { return undefined; }
}

export default function App() {
  let projectPicker: HTMLDivElement | undefined;
  let dashboardScrollY = 0;
  let refreshTimer: number | undefined;
  let nativeTimer: number | undefined;
  let stopListeningForAppLinks: (() => void) | undefined;
  let stopListeningForNativeInfo: (() => void) | undefined;
  let dashboardStarted = false;
  let connectedDesktopUrl: string | undefined;
  let serverDashboardAttempt: Promise<boolean> | undefined;
  const serverDashboardReturn = connectedDashboardReturnUrl();
  const loadedDashboardVersion = document.querySelector<HTMLMetaElement>('meta[name="livetree-dashboard-version"]')?.content;
  const [state, setState] = createSignal<DashboardState>();
  const [selectedProjectId, setSelectedProjectIdSignal] = createSignal<string | undefined>(storedString("livetree.selectedProjectId"));
  const [selectedPath, setSelectedPath] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  const [toasts, setToasts] = createSignal<ActivityToast[]>([]);
  const [logs, setLogs] = createSignal<LogSelection>();
  const [refreshing, setRefreshing] = createSignal(false);
  const [worktreeCollapsed, setWorktreeCollapsed] = createSignal(storedBoolean("livetree.worktreeRailCollapsed"));
  const [worktreeWidth, setWorktreeWidth] = createSignal(storedWidth("livetree.worktreeRailWidth", 294));
  const [terminalWidth, setTerminalWidth] = createSignal(storedWidth("livetree.terminalWidth", 440));
  const [mobileView, setMobileView] = createSignal<MobileView>("worktrees");
  const [projectMenuOpen, setProjectMenuOpen] = createSignal(false);
  const [nativeInfo, setNativeInfo] = createSignal<NativeInfo>();
  const [appReady, setAppReady] = createSignal(!runningInTauri());
  const [projectDialogOpen, setProjectDialogOpen] = createSignal(false);
  const [projectPath, setProjectPath] = createSignal("");
  const [projectFormError, setProjectFormError] = createSignal<string>();
  const [projectToRemove, setProjectToRemove] = createSignal<Project>();
  const [projectRemoveError, setProjectRemoveError] = createSignal<string>();
  const [worktreeToRemove, setWorktreeToRemove] = createSignal<{ project: Project; worktree: Worktree }>();
  const [settingsDialogOpen, setSettingsDialogOpen] = createSignal(false);
  const [changeDesktopOpen, setChangeDesktopOpen] = createSignal(false);
  const [settingsError, setSettingsError] = createSignal<string>();
  const toastTimers = new Map<string, number>();

  createEffect(() => {
    document.documentElement.classList.toggle("menu-bar-mode", Boolean(nativeInfo()?.menuBarMode));
  });

  function setSelectedProjectId(value: string | undefined): void {
    setSelectedProjectIdSignal(value);
    try {
      if (value) window.localStorage.setItem("livetree.selectedProjectId", value);
      else window.localStorage.removeItem("livetree.selectedProjectId");
    } catch {
      // Selection persistence is best effort when storage is unavailable.
    }
  }

  const selectedProject = createMemo(() => {
    const current = state();
    return current?.projects.find((project) => project.id === selectedProjectId()) ?? current?.projects[0];
  });
  const selectedWorktree = createMemo(() => {
    const project = selectedProject();
    return project?.worktrees.find((worktree) => worktree.path === selectedPath()) ?? project?.worktrees[0];
  });
  const filteredWorktrees = createMemo(() => selectedProject()?.worktrees ?? []);
  const activeConnectionStatus = createMemo(() => {
    const info = nativeInfo();
    if (!info) {
      if (!serverDashboardReturn) return undefined;
      return connectionStatus({
        platform: "ios",
        serverMode: state() ? "tailscale" : error() ? "error" : "starting",
        dashboardReady: Boolean(state()),
        dashboardError: Boolean(error() && !state()),
      });
    }
    let serverMode: ServerMode = info.serverMode;
    if (info.platform === "ios" && appReady()) {
      serverMode = state() ? "tailscale" : error() ? "error" : "starting";
    }
    return connectionStatus({
      platform: info.platform,
      serverMode,
      dashboardReady: Boolean(state()),
      dashboardError: Boolean(error() && !state()),
    });
  });

  function runningCount(project: Project): number {
    return project.worktrees.flatMap((tree) => tree.scripts).filter((script) => script.running).length;
  }

  function beginBusy(key: string): void {
    setBusy((current) => new Set(current).add(key));
  }

  function endBusy(key: string): void {
    setBusy((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function isBusy(key: string): boolean {
    return busy().has(key);
  }

  function showToast(toast: ActivityToast): void {
    const timer = toastTimers.get(toast.id);
    if (timer) window.clearTimeout(timer);
    toastTimers.delete(toast.id);
    setToasts((current) => [...current.filter((candidate) => candidate.id !== toast.id), toast]);
  }

  function dismissToast(id: string): void {
    const timer = toastTimers.get(id);
    if (timer) window.clearTimeout(timer);
    toastTimers.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function dismissToastLater(id: string): void {
    const timer = window.setTimeout(() => dismissToast(id), 3_000);
    toastTimers.set(id, timer);
  }

  async function load(showSpinner = false): Promise<void> {
    if (showSpinner) setRefreshing(true);
    try {
      const response = await fetch(apiUrl("state"), { cache: "no-store" });
      const payload = (await response.json()) as DashboardState & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to load livetree");
      if (loadedDashboardVersion && payload.dashboardVersion && /^[a-f0-9]{16}$/.test(payload.dashboardVersion) && payload.dashboardVersion !== loadedDashboardVersion) {
        window.location.reload();
        return;
      }
      setState(payload);
      const project = payload.projects.find((candidate) => candidate.id === selectedProjectId()) ?? payload.projects[0];
      setSelectedProjectId(project?.id);
      if (!selectedPath() || !project?.worktrees.some((tree) => tree.path === selectedPath())) {
        setSelectedPath(project?.worktrees[0]?.path);
      }
      setError(undefined);
      if (connectedDesktopUrl) tryServerDashboard(connectedDesktopUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRefreshing(false);
    }
  }

  function startDashboard(): void {
    if (dashboardStarted) return;
    dashboardStarted = true;
    void load();
    refreshTimer = window.setInterval(() => void load(), 5_000);
  }

  function connectToDesktop(value: string): void {
    const normalized = normalizeDesktopUrl(value);
    window.localStorage.setItem("livetree.desktopUrl", normalized);
    connectedDesktopUrl = normalized;
    if (runningInTauri()) {
      void persistDesktopUrl(normalized)
        .then(() => tryServerDashboard(normalized))
        .catch((caught) => console.error("Unable to save desktop URL", caught));
    }
    setApiBase(normalized);
    setState(undefined);
    setError(undefined);
    setAppReady(true);
    if (dashboardStarted) void load(true);
    else startDashboard();
  }

  function openMobileAppLinks(urls: string[]): void {
    for (const url of urls) {
      try {
        const desktopUrl = desktopUrlFromMobileAppLink(url);
        if (!desktopUrl) continue;
        setChangeDesktopOpen(false);
        connectToDesktop(desktopUrl);
        return;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return;
      }
    }
  }

  function tryServerDashboard(value: string): void {
    if (serverDashboardAttempt || changeDesktopOpen() || nativeInfo()?.platform !== "ios" || serverDashboardReturn) return;
    const attempt = loadServerDashboard(value).catch(() => false);
    serverDashboardAttempt = attempt;
    void attempt.finally(() => {
      if (serverDashboardAttempt === attempt) serverDashboardAttempt = undefined;
    });
  }

  function changeDesktop(): void {
    setSettingsDialogOpen(false);
    setChangeDesktopOpen(true);
  }

  function continueDesktopChange(): void {
    if (serverDashboardReturn) window.location.replace(serverDashboardReturn);
  }

  function finishDesktopChange(value: string): void {
    connectToDesktop(value);
    setChangeDesktopOpen(false);
  }

  function cancelDesktopChange(): void {
    setChangeDesktopOpen(false);
    if (connectedDesktopUrl) tryServerDashboard(connectedDesktopUrl);
  }

  async function action(kind: string, project: Project, worktree: Worktree, script: Script): Promise<void> {
    if (isBusy(`worktree:remove:${worktree.path}`)) return;
    const key = `${project.id}:${worktree.path}:${script.script}:${kind}`;
    beginBusy(key);
    try {
      const response = await fetch(apiUrl(kind), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: project.id, worktree: worktree.path, script: script.script }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Action failed");
      await load();
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      endBusy(key);
    }
  }

  async function startTailnet(): Promise<void> {
    const key = "tailnet:start";
    if (isBusy(key)) return;
    beginBusy(key);
    try {
      const response = await fetch(apiUrl("tailnet/start"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to start the Tailscale Link");
      await load();
      setError(undefined);
    } catch (caught) {
      await load();
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      endBusy(key);
    }
  }

  async function saveProject(path: string): Promise<void> {
    const key = "project:add";
    beginBusy(key);
    setProjectFormError(undefined);
    try {
      const response = await fetch(apiUrl("projects/add"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const payload = (await response.json()) as { error?: string; project?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to add project");
      setSelectedProjectId(payload.project);
      setSelectedPath(undefined);
      await load();
      setProjectDialogOpen(false);
      setProjectPath("");
      setError(undefined);
    } catch (caught) {
      setProjectFormError(caught instanceof Error ? caught.message : String(caught));
      setProjectDialogOpen(true);
    } finally {
      endBusy(key);
    }
  }

  async function addProject(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await saveProject(projectPath());
  }

  async function chooseProject(): Promise<void> {
    if (!runningInTauri()) {
      setProjectFormError(undefined);
      setProjectDialogOpen(true);
      return;
    }
    const key = "project:pick";
    beginBusy(key);
    try {
      const selected = await pickProjectFolder();
      endBusy(key);
      if (!selected) return;
      setProjectPath(selected);
      await saveProject(selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      endBusy(key);
    }
  }

  function requestProjectRemoval(project: Project): void {
    if (isBusy(`worktree:remove-project:${project.id}`)) return;
    setProjectRemoveError(undefined);
    setProjectToRemove(project);
  }

  async function confirmProjectRemoval(project: Project): Promise<void> {
    const key = `project:remove:${project.id}`;
    beginBusy(key);
    setProjectRemoveError(undefined);
    try {
      const response = await fetch(apiUrl("projects/remove"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: project.id }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to remove project");
      if (selectedProjectId() === project.id) {
        setSelectedProjectId(undefined);
        setSelectedPath(undefined);
        setLogs(undefined);
      }
      await load();
      setProjectToRemove(undefined);
      setError(undefined);
    } catch (caught) {
      setProjectRemoveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      endBusy(key);
    }
  }

  function requestWorktreeRemoval(project: Project, worktree: Worktree): void {
    if (isBusy(`worktree:remove-project:${project.id}`)) return;
    setWorktreeToRemove({ project, worktree });
  }

  async function confirmWorktreeRemoval(project: Project, worktree: Worktree): Promise<void> {
    const key = `worktree:remove:${worktree.path}`;
    const projectKey = `worktree:remove-project:${project.id}`;
    const toastId = key;
    const title = worktreeTitle(worktree);
    beginBusy(key);
    beginBusy(projectKey);
    setWorktreeToRemove(undefined);
    if (selectedPath() === worktree.path) {
      setSelectedPath(project.worktrees.find((candidate) => candidate.path !== worktree.path)?.path);
    }
    if (logs()?.worktree.path === worktree.path) setLogs(undefined);
    showToast({ id: toastId, tone: "loading", title: `Removing ${title}`, message: "Deleting the worktree in the background…" });
    if (window.matchMedia("(max-width: 820px)").matches) {
      setMobileView("worktrees");
      history.replaceState({ ...history.state, livetreeMobileView: "worktrees", livetreeTerminal: undefined }, "");
    }
    try {
      const response = await fetch(apiUrl("worktrees/remove"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: project.id, worktree: worktree.path, force: true }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to remove worktree");
      await load();
      showToast({ id: toastId, tone: "success", title: `Removed ${title}`, message: "The Git branch was kept." });
      dismissToastLater(toastId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      showToast({ id: toastId, tone: "error", title: `Could not remove ${title}`, message });
      await load();
    } finally {
      endBusy(key);
      endBusy(projectKey);
    }
  }

  onMount(() => {
    const settingsRequested = runningInTauri() && bundledSettingsRequested();
    if (settingsRequested) {
      clearBundledSettingsRequest();
      setChangeDesktopOpen(true);
    }
    if (!runningInTauri()) {
      startDashboard();
    } else {
      void (async () => {
        stopListeningForNativeInfo = await listen<NativeInfo>("native-info-changed", (event) => setNativeInfo(event.payload));
        stopListeningForAppLinks = await onOpenUrl(openMobileAppLinks);
        openMobileAppLinks((await getCurrent()) ?? []);
      })().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
      const refreshNative = async () => {
        try {
          const info = await readNativeInfo();
          setNativeInfo(info);
          if (info.platform === "macos" && info.serverUrl && !appReady()) {
            setApiBase(info.serverUrl);
            setAppReady(true);
            startDashboard();
          }
          if (info.platform === "ios" && !appReady()) {
            const stored = await readPersistedDesktopUrl().catch(() => null) ?? window.localStorage.getItem("livetree.desktopUrl");
            if (stored) connectToDesktop(stored);
          }
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      };
      void refreshNative();
      nativeTimer = window.setInterval(() => void refreshNative(), 1_000);
    }
    const mobileQuery = window.matchMedia("(max-width: 820px)");
    const trackpadBackSwipe = createPaneBackSwipeRecognizer();
    if (mobileQuery.matches) {
      const initial = history.state?.livetreeMobileView;
      const view: MobileView = initial === "workspace" ? "workspace" : "worktrees";
      setMobileView(view);
      history.replaceState({ ...history.state, livetreeMobileView: view }, "");
    }
    const onPopState = (event: PopStateEvent) => {
      const view = event.state?.livetreeMobileView;
      setMobileView(view === "workspace" ? "workspace" : "worktrees");
      const terminal = event.state?.livetreeTerminal;
      if (terminal && typeof terminal.project === "string" && typeof terminal.worktree === "string" && typeof terminal.script === "string") {
        const project = state()?.projects.find((candidate) => candidate.id === terminal.project);
        const worktree = project?.worktrees.find((candidate) => candidate.path === terminal.worktree);
        const script = worktree?.scripts.find((candidate) => candidate.script === terminal.script);
        if (project && worktree && script) setLogs({ project, worktree, script });
      } else if (logs()) {
        closeLogsNow();
      }
    };
    let backSwipe: { pointerId: number; startX: number; startY: number } | undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (
        !mobileQuery.matches ||
        !appReady() ||
        event.pointerType !== "touch" ||
        event.clientX > 28 ||
        (!logs() && mobileView() === "worktrees")
      ) {
        return;
      }
      backSwipe = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      const swipe = backSwipe;
      backSwipe = undefined;
      if (!swipe || event.pointerId !== swipe.pointerId) return;
      const distanceX = event.clientX - swipe.startX;
      const distanceY = Math.abs(event.clientY - swipe.startY);
      if (distanceX < 72 || distanceX <= distanceY * 1.5) return;
      if (logs()) {
        closeLogs();
      } else if (mobileView() === "workspace") {
        backMobile("worktrees");
      }
    };
    const onPointerCancel = () => {
      backSwipe = undefined;
    };
    const onWheel = (event: WheelEvent) => {
      const canGoBack = Boolean(logs()) || (mobileQuery.matches && mobileView() === "workspace");
      const dialogOpen = settingsDialogOpen() || projectDialogOpen() || Boolean(projectToRemove()) || Boolean(worktreeToRemove());
      if (nativeInfo()?.platform !== "macos" || !canGoBack || dialogOpen || event.ctrlKey || event.metaKey) {
        trackpadBackSwipe.reset();
        return;
      }
      if (!trackpadBackSwipe.update(event)) return;
      event.preventDefault();
      if (logs()) closeLogs();
      else backMobile("worktrees");
    };
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (projectMenuOpen() && !projectPicker?.contains(event.target as Node)) setProjectMenuOpen(false);
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectMenuOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onDocumentKeyDown);
    onCleanup(() => {
      window.clearInterval(refreshTimer);
      window.clearInterval(nativeTimer);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("wheel", onWheel);
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
      stopListeningForAppLinks?.();
      stopListeningForNativeInfo?.();
      document.documentElement.classList.remove("menu-bar-mode");
      for (const timer of toastTimers.values()) window.clearTimeout(timer);
      toastTimers.clear();
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

  function selectProject(project: Project): void {
    setSelectedProjectId(project.id);
    setSelectedPath(project.worktrees[0]?.path);
    setLogs(undefined);
    setProjectMenuOpen(false);
    if (window.matchMedia("(max-width: 820px)").matches && mobileView() !== "worktrees") navigateMobile("worktrees");
  }

  function openLogs(project: Project, worktree: Worktree, script: Script): void {
    dashboardScrollY = window.scrollY;
    setLogs({ project, worktree, script });
    if (window.matchMedia("(max-width: 820px)").matches) {
      history.pushState({
        ...history.state,
        livetreeMobileView: mobileView(),
        livetreeTerminal: { project: project.id, worktree: worktree.path, script: script.script },
      }, "");
    }
  }

  function closeLogs(): void {
    if (history.state?.livetreeTerminal) {
      history.back();
      return;
    }
    closeLogsNow();
  }

  function closeLogsNow(): void {
    setLogs(undefined);
    requestAnimationFrame(() => window.scrollTo({ top: dashboardScrollY }));
  }

  function toggleWorktreeRail(): void {
    const next = !worktreeCollapsed();
    setWorktreeCollapsed(next);
    try { window.localStorage.setItem("livetree.worktreeRailCollapsed", String(next)); } catch {}
  }

  async function changeMenuBarMode(enabled: boolean): Promise<void> {
    const key = "settings:menu-bar";
    if (isBusy(key)) return;
    beginBusy(key);
    setSettingsError(undefined);
    try {
      setNativeInfo(await setMenuBarMode(enabled));
      setSettingsDialogOpen(false);
    } catch (caught) {
      setSettingsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      endBusy(key);
    }
  }

  function beginWorktreeResize(event: PointerEvent): void {
    if (window.matchMedia("(max-width: 820px)").matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = worktreeWidth();
    const limits = [220, 440];
    let currentWidth = startWidth;
    document.body.classList.add("is-resizing-rail");
    const move = (moveEvent: PointerEvent) => {
      currentWidth = Math.min(limits[1], Math.max(limits[0], startWidth + moveEvent.clientX - startX));
      setWorktreeWidth(currentWidth);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("is-resizing-rail");
      try { window.localStorage.setItem("livetree.worktreeRailWidth", String(currentWidth)); } catch {}
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
    <Show when={appReady()} fallback={
      <ConnectionSetup
        platform={nativeInfo()?.platform}
        mode={changeDesktopOpen() ? "change" : "initial"}
        error={nativeInfo()?.error ?? error()}
        onConnect={changeDesktopOpen() ? finishDesktopChange : connectToDesktop}
        onCancel={changeDesktopOpen() ? cancelDesktopChange : undefined}
      />
    }>
    <div
      class="app-shell"
      classList={{
        "app-shell--worktree-collapsed": worktreeCollapsed(),
        "app-shell--terminal-open": Boolean(logs()),
        "mobile-view--worktrees": mobileView() === "worktrees",
        "mobile-view--workspace": mobileView() === "workspace",
        "app-shell--macos": nativeInfo()?.platform === "macos",
        "app-shell--menu-bar": nativeInfo()?.menuBarMode,
      }}
      style={`--worktree-width:${worktreeWidth()}px;--terminal-width:${terminalWidth()}px`}
    >
      <Show when={nativeInfo()?.platform === "macos"}><div class="macos-titlebar-drag-region" data-tauri-drag-region /></Show>
      <aside class="worktree-rail">
        <div class="pane-titlebar-drag-region pane-titlebar-drag-region--rail" data-tauri-drag-region />
        <header class="worktree-rail__header">
          <div class="project-picker" ref={projectPicker}>
            <button
              type="button"
              class="project-picker__trigger"
              aria-label="Select project"
              aria-haspopup="menu"
              aria-expanded={projectMenuOpen()}
              onClick={() => setProjectMenuOpen((open) => !open)}
            >
              <span class="project-picker__icon"><FolderGit2 size={16} /></span>
              <span class="project-picker__copy"><small>Project</small><strong>{selectedProject()?.name ?? (state() ? "No project" : "Loading")}</strong></span>
              <ChevronDown size={15} class="project-picker__chevron" classList={{ "project-picker__chevron--open": projectMenuOpen() }} />
            </button>
            <Show when={projectMenuOpen()}>
              <div class="project-menu" role="menu" aria-label="Projects">
                <div class="project-menu__label">Switch project</div>
                <Show when={state()} fallback={<div class="project-menu__empty">Loading projects…</div>}>
                  {(current) => (
                    <>
                      <For each={current().projects}>
                        {(project) => (
                          <div class="project-menu__row" classList={{ "project-menu__row--active": selectedProject()?.id === project.id }}>
                            <button type="button" class="project-menu__option" role="menuitemradio" aria-checked={selectedProject()?.id === project.id} title={project.path} onClick={() => selectProject(project)}>
                              <FolderGit2 size={16} />
                              <span><strong>{project.name}</strong><small>{project.worktrees.length} worktrees · {runningCount(project)} running</small></span>
                              <Show when={selectedProject()?.id === project.id}><Check size={15} /></Show>
                            </button>
                            <button
                              type="button"
                              class="project-menu__remove"
                              aria-label={`Remove ${project.name} from project list`}
                              title="Remove from list"
                              disabled={isBusy(`project:remove:${project.id}`) || isBusy(`worktree:remove-project:${project.id}`)}
                              onClick={() => { setProjectMenuOpen(false); requestProjectRemoval(project); }}
                            >
                              {isBusy(`project:remove:${project.id}`) ? <LoaderCircle class="spin" size={13} /> : <X size={13} />}
                            </button>
                          </div>
                        )}
                      </For>
                      <Show when={current().projects.length === 0}><div class="project-menu__empty">No projects yet</div></Show>
                    </>
                  )}
                </Show>
                <button type="button" class="project-menu__add" role="menuitem" disabled={isBusy("project:pick") || isBusy("project:add")} onClick={() => { setProjectMenuOpen(false); void chooseProject(); }}>
                  {isBusy("project:pick") ? <LoaderCircle class="spin" size={14} /> : <Plus size={15} />} Add project
                </button>
              </div>
            </Show>
          </div>
          <div class="worktree-rail__controls">
            <Show when={nativeInfo()?.platform === "macos" || nativeInfo()?.platform === "ios" || serverDashboardReturn}>
              <Button size="icon" variant="ghost" aria-label="Settings" title="Settings" onClick={() => { setSettingsError(undefined); setSettingsDialogOpen(true); }}>
                <Settings size={16} />
              </Button>
            </Show>
            <Button size="icon" variant="ghost" class="refresh-button" aria-label="Refresh dashboard" onClick={() => void load(true)}>
              <RefreshCw size={16} classList={{ spin: refreshing() }} />
            </Button>
            <Button size="icon" variant="ghost" class="rail-toggle" aria-label={worktreeCollapsed() ? "Expand worktrees sidebar" : "Collapse worktrees sidebar"} aria-expanded={!worktreeCollapsed()} onClick={toggleWorktreeRail}>
              {worktreeCollapsed() ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </Button>
          </div>
        </header>
        <div class="worktree-list" aria-label="Worktrees">
          <For each={filteredWorktrees()}>
            {(worktree) => {
              return (
                <button type="button" class="worktree-item" classList={{ "worktree-item--active": selectedWorktree()?.path === worktree.path }} aria-label={`${worktreeTitle(worktree)}, branch ${branchTitle(worktree)}`} title={worktreeCollapsed() ? worktreeTitle(worktree) : undefined} disabled={isBusy(`worktree:remove:${worktree.path}`)} onClick={() => { setSelectedPath(worktree.path); navigateMobile("workspace"); }}>
                  <span class="worktree-item__collapsed-mark">{worktree.isMain ? "M" : <Show when={worktree.chat}>{(chat) => <AgentIcon provider={chat().provider} />}</Show>}</span>
                  <span class="worktree-item__copy">
                    <span><strong>{worktreeTitle(worktree)}</strong><Show when={worktree.chat}>{(chat) => <AgentIcon provider={chat().provider} />}</Show></span>
                    <small class="worktree-item__branch"><b>Branch</b> {branchTitle(worktree)}</small>
                    <small>Updated {age(worktree.modifiedAtMs)} ago</small>
                  </span>
                  <ChevronRight size={17} class="mobile-disclosure" />
                </button>
              );
            }}
          </For>
          <Show when={filteredWorktrees().length === 0}><div class="empty-filter">{selectedProject() ? "No matching worktrees" : "No worktrees"}</div></Show>
        </div>
        <Show when={activeConnectionStatus() || (nativeInfo()?.platform !== "ios" && !serverDashboardReturn)}>
          <div class="worktree-rail__footer">
            <Show when={activeConnectionStatus()}>{(status) => <span class={`connection-mode connection-mode--${status().tone}`} title={status().title}><i />{status().label}</span>}</Show>
            <Show when={nativeInfo()?.platform !== "ios" && !serverDashboardReturn}>
              <div class="worktree-rail__footer-action">
                <Switch fallback={<button type="button" class="tailnet-copy" disabled={isBusy("tailnet:start")} onClick={() => void startTailnet()}><MonitorSmartphone size={13} />Enable Tailscale Link</button>}>
                  <Match when={state()?.tailnet.status === "ready" && state()?.tailnet.url}>
                    <button type="button" class="tailnet-copy" title={state()?.tailnet.url ?? undefined} onClick={() => void navigator.clipboard.writeText(state()?.tailnet.url ?? "")}><MonitorSmartphone size={13} />Copy Tailscale Link</button>
                  </Match>
                  <Match when={state()?.tailnet.status === "starting" || isBusy("tailnet:start")}>
                    <span class="tailnet-status" title="Starting Tailscale Serve"><LoaderCircle class="spin" size={13} />Starting Tailscale Link</span>
                  </Match>
                  <Match when={state()?.tailnet.status === "unavailable"}>
                    <button type="button" class="tailnet-copy" title={state()?.tailnet.error ?? "Tailscale is unavailable"} disabled={isBusy("tailnet:start")} onClick={() => void startTailnet()}><MonitorSmartphone size={13} />Retry Tailscale Link</button>
                  </Match>
                </Switch>
              </div>
            </Show>
          </div>
        </Show>
        <div class="rail-resizer" role="separator" aria-label="Resize worktrees sidebar" aria-orientation="vertical" aria-valuemin="220" aria-valuemax="440" aria-valuenow={worktreeWidth()} onPointerDown={beginWorktreeResize} />
      </aside>

      <main class="workspace">
        <div class="pane-titlebar-drag-region pane-titlebar-drag-region--workspace" data-tauri-drag-region />
        <div class="mobile-stack-header">
          <Button size="sm" variant="ghost" class="mobile-back" aria-label="Back to worktrees" onClick={() => backMobile("worktrees")}><ChevronLeft size={18} /><span>Worktrees</span></Button>
          <strong>{selectedProject()?.name ?? "livetree"}</strong>
          <span class="mobile-stack-header__spacer" />
        </div>
        <Show when={worktreeCollapsed()}>
          <div class="workspace-rail-controls">
            <Button size="icon" variant="ghost" aria-label="Expand worktrees sidebar" onClick={toggleWorktreeRail}><PanelLeftOpen size={16} /></Button>
          </div>
        </Show>
        <Show when={error()}>{(message) => <div class="error-banner" role="alert"><strong>Something went wrong</strong><span>{message()}</span><Show when={nativeInfo()?.platform === "ios" || serverDashboardReturn}><Button size="sm" variant="outline" onClick={changeDesktop}>Change server</Button></Show><Button size="sm" onClick={() => void load(true)}>Try again</Button></div>}</Show>
        <Show when={selectedProject()} fallback={
          <Show when={state()} fallback={<LoadingState />}>
            <div class="empty-projects-state">
              <span><FolderGit2 size={24} /></span>
              <h2>Add your first project</h2>
              <p>Choose a Git repository with a .ltconf file to start managing its worktrees.</p>
              <Button class="empty-projects-state__add" variant="primary" disabled={isBusy("project:pick") || isBusy("project:add")} onClick={() => void chooseProject()}>{isBusy("project:pick") ? <LoaderCircle class="spin" size={14} /> : <Folder size={15} />}Choose project folder</Button>
            </div>
          </Show>
        }>
          {(project) => (
            <Show when={selectedWorktree()} fallback={<LoadingState />}>
              {(worktree) => (
                <WorktreeView
                  projectId={project().id}
                  projectName={project().name}
                  worktree={worktree()}
                  platform={nativeInfo()?.platform}
                  busy={busy()}
                  onAction={(kind, targetWorktree, script) => action(kind, project(), targetWorktree, script)}
                  onLogs={(script) => openLogs(project(), worktree(), script)}
                  onRemove={() => requestWorktreeRemoval(project(), worktree())}
                />
              )}
            </Show>
          )}
        </Show>
      </main>
      <Show when={logs()}>{(selection) => <TerminalPage selection={selection()} onClose={closeLogs} onResizeStart={beginTerminalResize} width={terminalWidth()} />}</Show>
      <Show when={projectDialogOpen()}>
        <div class="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isBusy("project:add")) setProjectDialogOpen(false); }}>
          <section class="dialog-card" role="dialog" aria-modal="true" aria-labelledby="add-project-title" onKeyDown={(event) => { if (event.key === "Escape" && !isBusy("project:add")) setProjectDialogOpen(false); }}>
            <header class="dialog-card__header">
              <div><h2 id="add-project-title">Add project</h2><p>Enter the absolute path to a Git repository with a .ltconf file.</p></div>
              <Button size="icon" variant="ghost" aria-label="Close add project dialog" disabled={isBusy("project:add")} onClick={() => setProjectDialogOpen(false)}><X size={16} /></Button>
            </header>
            <form class="project-form" onSubmit={(event) => void addProject(event)}>
              <label for="project-path">Project folder</label>
              <input ref={(input) => queueMicrotask(() => input.focus())} id="project-path" type="text" autocomplete="off" autocapitalize="none" spellcheck={false} placeholder="/Users/you/code/project" value={projectPath()} onInput={(event) => setProjectPath(event.currentTarget.value)} />
              <Show when={projectFormError()}>{(message) => <div class="project-form__error" role="alert">{message()}</div>}</Show>
              <div class="dialog-card__actions">
                <Button type="button" variant="ghost" disabled={isBusy("project:add")} onClick={() => setProjectDialogOpen(false)}>Cancel</Button>
                <Button type="submit" variant="primary" disabled={!projectPath().trim() || isBusy("project:add")}>
                  {isBusy("project:add") ? <LoaderCircle class="spin" size={14} /> : <Plus size={14} />} Add project
                </Button>
              </div>
            </form>
          </section>
        </div>
      </Show>
      <Show when={settingsDialogOpen()}>
        <div class="dialog-backdrop dialog-backdrop--settings" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isBusy("settings:menu-bar")) setSettingsDialogOpen(false); }}>
          <section class="dialog-card settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={(event) => { if (event.key === "Escape" && !isBusy("settings:menu-bar")) setSettingsDialogOpen(false); }}>
            <header class="dialog-card__header">
              <div><h2 id="settings-title">Settings</h2><p>{nativeInfo()?.platform === "macos" ? "Choose how LiveTree appears on your Mac." : "Manage your LiveTree mobile app."}</p></div>
              <Button size="icon" variant="ghost" aria-label="Close settings" disabled={isBusy("settings:menu-bar")} onClick={() => setSettingsDialogOpen(false)}><X size={16} /></Button>
            </header>
            <Show when={nativeInfo()?.platform === "macos"} fallback={
              <div class="settings-option">
                <span><strong>Desktop</strong><small>Disconnect from this desktop and connect the mobile app to another one.</small></span>
                <Button variant="primary" onClick={changeDesktop}>Change desktop</Button>
              </div>
            }>
              <div class="settings-option">
                <Show when={nativeInfo()?.menuBarMode} fallback={
                  <><span><strong>Menu bar</strong><small>Open LiveTree from an icon-only menu bar item in a compact mobile layout.</small></span><Button variant="primary" disabled={isBusy("settings:menu-bar")} onClick={() => void changeMenuBarMode(true)}>{isBusy("settings:menu-bar") && <LoaderCircle class="spin" size={14} />}Move to menu bar</Button></>
                }>
                  <span><strong>Window</strong><small>Restore the full window and show LiveTree in the Dock and app switcher.</small></span><Button variant="primary" disabled={isBusy("settings:menu-bar")} onClick={() => void changeMenuBarMode(false)}>{isBusy("settings:menu-bar") && <LoaderCircle class="spin" size={14} />}Move to window</Button>
                </Show>
              </div>
            </Show>
            <Show when={settingsError()}>{(message) => <div class="project-form__error" role="alert">{message()}</div>}</Show>
          </section>
        </div>
      </Show>
      <Show when={worktreeToRemove()}>
        {(selection) => (
          <div class="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setWorktreeToRemove(undefined); }}>
            <section class="dialog-card remove-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-worktree-title" onKeyDown={(event) => { if (event.key === "Escape") setWorktreeToRemove(undefined); }}>
              <header class="dialog-card__header">
                <div class="remove-confirmation-dialog__title"><span><TriangleAlert size={18} /></span><div><h2 id="remove-worktree-title">Remove worktree?</h2><p>{worktreeTitle(selection().worktree)}</p></div></div>
                <Button size="icon" variant="ghost" aria-label="Close remove worktree dialog" onClick={() => setWorktreeToRemove(undefined)}><X size={16} /></Button>
              </header>
              <p class="remove-confirmation-dialog__warning">This permanently deletes the worktree folder, including all uncommitted and untracked changes. The Git branch will be kept.</p>
              <code class="remove-confirmation-dialog__path">{selection().worktree.path}</code>
              <div class="dialog-card__actions">
                <Button type="button" variant="ghost" onClick={() => setWorktreeToRemove(undefined)}>Cancel</Button>
                <Button type="button" variant="danger" onClick={() => void confirmWorktreeRemoval(selection().project, selection().worktree)}>
                  <Trash2 size={14} /> Remove worktree
                </Button>
              </div>
            </section>
          </div>
        )}
      </Show>
      <Show when={projectToRemove()}>
        {(project) => (
          <div class="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isBusy(`project:remove:${project().id}`)) setProjectToRemove(undefined); }}>
            <section class="dialog-card remove-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-project-title" onKeyDown={(event) => { if (event.key === "Escape" && !isBusy(`project:remove:${project().id}`)) setProjectToRemove(undefined); }}>
              <header class="dialog-card__header">
                <div class="remove-confirmation-dialog__title"><span><FolderGit2 size={18} /></span><div><h2 id="remove-project-title">Remove project from LiveTree?</h2><p>{project().name}</p></div></div>
                <Button size="icon" variant="ghost" aria-label="Close remove project dialog" disabled={isBusy(`project:remove:${project().id}`)} onClick={() => setProjectToRemove(undefined)}><X size={16} /></Button>
              </header>
              <p class="remove-confirmation-dialog__warning">This only removes the saved project entry. The repository folder, its worktrees, and all project files will stay on disk.</p>
              <code class="remove-confirmation-dialog__path">{project().path}</code>
              <Show when={projectRemoveError()}>{(message) => <div class="project-form__error" role="alert">{message()}</div>}</Show>
              <div class="dialog-card__actions">
                <Button type="button" variant="ghost" disabled={isBusy(`project:remove:${project().id}`)} onClick={() => setProjectToRemove(undefined)}>Cancel</Button>
                <Button type="button" variant="danger" disabled={isBusy(`project:remove:${project().id}`)} onClick={() => void confirmProjectRemoval(project())}>
                  {isBusy(`project:remove:${project().id}`) ? <LoaderCircle class="spin" size={14} /> : <X size={14} />} Remove from list
                </Button>
              </div>
            </section>
          </div>
        )}
      </Show>
      <Show when={changeDesktopOpen()}>
        <Show when={serverDashboardReturn} fallback={
          <ConnectionSetup platform="ios" mode="change" error={nativeInfo()?.error ?? undefined} onConnect={finishDesktopChange} onCancel={cancelDesktopChange} />
        }>
          <DesktopChangeConfirmation onContinue={continueDesktopChange} onCancel={cancelDesktopChange} />
        </Show>
      </Show>
      <div class="toast-stack" aria-live="polite" aria-label="Background activity">
        <For each={toasts()}>
          {(toast) => (
            <div class="activity-toast" classList={{ "activity-toast--success": toast.tone === "success", "activity-toast--error": toast.tone === "error" }} role={toast.tone === "error" ? "alert" : "status"}>
              <span class="activity-toast__icon">
                {toast.tone === "loading" ? <LoaderCircle class="spin" size={16} /> : toast.tone === "success" ? <Check size={16} /> : <TriangleAlert size={16} />}
              </span>
              <span class="activity-toast__copy"><strong>{toast.title}</strong><small>{toast.message}</small></span>
              <Show when={toast.tone !== "loading"}><button type="button" aria-label={`Dismiss ${toast.title}`} onClick={() => dismissToast(toast.id)}><X size={14} /></button></Show>
            </div>
          )}
        </For>
      </div>
    </div>
    </Show>
  );
}

function DesktopChangeConfirmation(props: { onContinue: () => void; onCancel: () => void }) {
  return (
    <main class="connection-setup connection-setup--overlay">
      <div class="connection-setup__card">
        <Button size="icon" variant="ghost" class="connection-setup__close" aria-label="Cancel changing desktop" onClick={props.onCancel}><X size={16} /></Button>
        <span class="brand__mark"><TreePine size={28} /></span>
        <div><h1>Change desktop?</h1><p>You’ll stay connected to this desktop unless you continue. Continuing opens the mobile app’s connection screen.</p></div>
        <div class="connection-setup__actions">
          <Button type="button" variant="ghost" onClick={props.onCancel}>Cancel</Button>
          <Button type="button" variant="primary" onClick={props.onContinue}>Continue</Button>
        </div>
      </div>
    </main>
  );
}

function ConnectionSetup(props: { platform?: NativeInfo["platform"]; mode?: "initial" | "change"; error?: string; onConnect: (url: string) => void; onCancel?: () => void }) {
  const [value, setValue] = createSignal("");
  const [validation, setValidation] = createSignal<string>();

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    try {
      props.onConnect(value());
      setValidation(undefined);
    } catch (caught) {
      setValidation(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <main class="connection-setup" classList={{ "connection-setup--overlay": props.mode === "change" }}>
      <Show when={props.platform === "macos"}><div class="macos-titlebar-drag-region" data-tauri-drag-region /></Show>
      <div class="connection-setup__card">
        <Show when={props.onCancel}><Button size="icon" variant="ghost" class="connection-setup__close" aria-label="Cancel changing desktop" onClick={props.onCancel}><X size={16} /></Button></Show>
        <span class="brand__mark"><TreePine size={28} /></span>
        <Show when={props.platform === "ios"} fallback={<div><h1>Starting LiveTree</h1><p>The Mac app is launching its embedded dashboard service.</p></div>}>
          <div><h1>{props.mode === "change" ? "Change desktop" : "Connect to LiveTree"}</h1><p>{props.mode === "change" ? "Paste another desktop’s Tailscale Link. Your current connection stays active until you connect to a new one." : "Open LiveTree on your Mac, copy its Tailscale Link, and paste it here. Both devices must be signed into the same Tailscale network."}</p></div>
          <form onSubmit={submit}>
            <label for="desktop-url">Tailnet dashboard URL</label>
            <input id="desktop-url" type="url" inputmode="url" autocomplete="url" autocapitalize="none" placeholder="https://your-mac.tailnet.ts.net" value={value()} onInput={(event) => setValue(event.currentTarget.value)} />
            <Button type="submit" disabled={!value().trim()}>Connect</Button>
            <Show when={props.onCancel}><Button type="button" variant="ghost" onClick={props.onCancel}>Cancel</Button></Show>
          </form>
        </Show>
        <Show when={validation() ?? props.error}>{(message) => <div class="connection-setup__error" role="alert">{message()}</div>}</Show>
      </div>
    </main>
  );
}

function LoadingState() {
  return <div class="loading-state"><LoaderCircle class="spin" size={22} /><span>Loading your worktrees</span></div>;
}

function WorktreeView(props: {
  projectId: string;
  projectName: string;
  worktree: Worktree;
  platform?: NativeInfo["platform"];
  busy: ReadonlySet<string>;
  onAction: (kind: string, worktree: Worktree, script: Script) => Promise<void>;
  onLogs: (script: Script) => void;
  onRemove: () => void;
}) {
  const [copiedPath, setCopiedPath] = createSignal<string>();
  const [expandedQr, setExpandedQr] = createSignal<string>();
  const [shortcutError, setShortcutError] = createSignal<{ name: string; message: string }>();
  let copiedTimer: number | undefined;
  const actionKey = (kind: string, script: Script) => `${props.projectId}:${props.worktree.path}:${script.script}:${kind}`;
  const isBusy = (kind: string, script: Script) => props.busy.has(actionKey(kind, script));
  const isScriptBusy = (script: Script) => props.busy.has(`worktree:remove:${props.worktree.path}`) || ["dev/start", "dev/stop", "tunnel/start", "tunnel/stop"].some((kind) => isBusy(kind, script));

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

  async function openShortcut(event: MouseEvent, link: Link): Promise<void> {
    if (!link.url) return;
    const nativeBridge = nativeLinkOpenerAvailable();
    if (!nativeBridge) {
      if (!shouldUseSameViewLink({ nativeBridge, mobileViewport: window.matchMedia("(max-width: 820px)").matches })) return;
      event.preventDefault();
      window.location.assign(link.url);
      return;
    }
    event.preventDefault();
    setShortcutError(undefined);
    try {
      await openExternalUrl(link.url);
    } catch (caught) {
      const protocol = new URL(link.url).protocol;
      const requiresMobileApp = protocol !== "http:" && protocol !== "https:";
      if (props.platform === "macos" && requiresMobileApp && link.qr) {
        setExpandedQr(link.name);
        setShortcutError({ name: link.name, message: "This shortcut opens on iPhone. Scan the QR code below." });
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      setShortcutError({ name: link.name, message: `Unable to open shortcut: ${message}` });
    }
  }

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
                <Folder size={12} /><span>{shortPath(props.worktree.path)}</span>{copiedPath() === props.worktree.path ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </Show>
          </div>
        </div>
        <Show when={!props.worktree.isMain}>
          <Button class="remove-worktree-button" size="icon" variant="danger" aria-label="Remove worktree" title="Remove worktree" disabled={props.busy.has(`worktree:remove-project:${props.projectId}`)} onClick={() => void props.onRemove()}>
            {props.busy.has(`worktree:remove:${props.worktree.path}`) ? <LoaderCircle class="spin" size={14} /> : <Trash2 size={14} />}
          </Button>
        </Show>
      </header>

      <section class="section-block">
        <div class="section-heading"><h3>Dev Servers</h3></div>
        <div class="server-list">
          <For each={props.worktree.scripts} fallback={<EmptyState icon={<Server size={20} />} title="No servers configured" copy="Add a dev script to .ltconf to see it here." />}>
            {(script) => (
              <Card class="server-card">
                <div class="server-card__identity">
                  <div>
                    <div class="server-name">
                      <strong>{script.script}</strong>
                      <Badge tone={script.healthy ? "success" : script.running ? "warning" : "neutral"}>{script.healthy ? "healthy" : script.running ? "starting" : "stopped"}</Badge>
                    </div>
                    <span class="server-meta">{script.running ? `PID ${script.pid} · up ${age(script.startedAtMs)}` : "Ready to start"}</span>
                  </div>
                </div>
                <a class="server-primary-link" href={script.url} target="_blank" rel="noreferrer" aria-label={`Open ${script.script}`} onClick={(event) => openExternalLink(event, script.url)}><ArrowUpRight size={16} /></a>
                <Show when={script.tunnelUrl}><a class="server-tunnel-link" href={script.tunnelUrl!} target="_blank" rel="noreferrer" aria-label={`Open ${script.script} via Tailnet`} onClick={(event) => openExternalLink(event, script.tunnelUrl!)}><Wifi size={16} /></a></Show>
                <div class="server-card__actions">
                  <Button size="icon" variant={script.running ? "danger" : "primary"} aria-label={`${script.running ? "Stop" : "Start"} ${script.script}`} disabled={isScriptBusy(script)} onClick={() => void props.onAction(`dev/${script.running ? "stop" : "start"}`, props.worktree, script)}>
                    {isBusy(`dev/${script.running ? "stop" : "start"}`, script) ? <LoaderCircle class="spin" size={15} /> : script.running ? <Square size={13} /> : <Play size={14} />}
                  </Button>
                  <Show when={script.running}>
                    <Button size="icon" variant="outline" aria-label={`${script.tunnelUrl ? "Stop Tailscale" : "Start Tailscale"} for ${script.script}`} disabled={isScriptBusy(script)} onClick={() => void props.onAction(`tunnel/${script.tunnelUrl ? "stop" : "start"}`, props.worktree, script)}>
                      {isBusy(`tunnel/${script.tunnelUrl ? "stop" : "start"}`, script) ? <LoaderCircle class="spin" size={15} /> : <RadioTower size={15} />}
                    </Button>
                  </Show>
                </div>
                <button type="button" class="server-card__logs" disabled={!script.running || !script.logPath} aria-label={script.running && script.logPath ? `Open ${script.script} logs in side pane` : `${script.script} logs unavailable`} onClick={() => props.onLogs(script)}><TerminalIcon size={15} /></button>
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
              <Card class={`link-card${link.available && link.url ? " link-card--available" : ""}`}>
                <div class="link-card__heading">
                  <strong>{link.name}</strong>
                  <Show when={link.available && link.url}>
                    <a class="shortcut-link" href={link.url!} target="_blank" rel="noreferrer" aria-label={`Open ${link.name}`} onClick={(event) => void openShortcut(event, link)}><ArrowUpRight size={16} /></a>
                  </Show>
                  <Badge tone={link.available ? "success" : "warning"}>{link.available ? "available" : "unavailable"}</Badge>
                </div>
                <Show when={!link.available || !link.url}><span class="link-card__error">{link.error}</span></Show>
                <Show when={shortcutError()?.name === link.name}><span class="link-card__error">{shortcutError()?.message}</span></Show>
                <Show when={link.qr}>
                  <details class="qr-details" open={expandedQr() === link.name} onToggle={(event) => setExpandedQr(event.currentTarget.open ? link.name : undefined)}>
                    <summary>Show QR code</summary>
                    <Show when={expandedQr() === link.name}><img src={`data:image/svg+xml,${encodeURIComponent(link.qr!)}`} alt={`QR code for ${link.name}`} /></Show>
                  </details>
                </Show>
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
