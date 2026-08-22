import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowLeft, X } from "lucide-solid";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Button } from "./components/ui/button";
import { apiUrl } from "./native";
import { terminalTheme, useSystemAppearance } from "./theme";
import type { LogSelection } from "./types";

export function TerminalPage(props: { selection: LogSelection; onClose: () => void; onResizeStart: (event: PointerEvent) => void; width: number }) {
  let container!: HTMLDivElement;
  const appearance = useSystemAppearance();
  const [connectionLabel, setConnectionLabel] = createSignal("Connecting");
  const worktreeLabel = () => props.selection.worktree.isMain
    ? "main"
    : props.selection.worktree.chat?.title ?? props.selection.worktree.ref ?? props.selection.worktree.label;

  onMount(() => {
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.45,
      scrollback: 10_000,
      theme: terminalTheme(appearance()),
    });
    createEffect(() => {
      terminal.options.theme = terminalTheme(appearance());
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    const disableTouchScrolling = enableTouchScrolling(container, terminal);
    requestAnimationFrame(() => fit.fit());
    terminal.writeln(`\x1b[2mStreaming ${props.selection.script.script} · ${props.selection.worktree.label}\x1b[0m`);
    terminal.writeln("");

    const observer = new ResizeObserver(() => requestAnimationFrame(() => fit.fit()));
    observer.observe(container);

    const controller = new AbortController();
    const url = apiUrl("logs");
    url.searchParams.set("project", props.selection.project.id);
    url.searchParams.set("worktree", props.selection.worktree.path);
    url.searchParams.set("script", props.selection.script.script);

    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string };
          throw new Error(payload.error ?? "Unable to stream logs");
        }
        if (!response.body) throw new Error("This browser does not support streamed responses");
        setConnectionLabel("Live");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          terminal.write(decoder.decode(value, { stream: true }));
        }
        setConnectionLabel("Ended");
      } catch (error) {
        if (controller.signal.aborted) return;
        setConnectionLabel("Unavailable");
        terminal.writeln(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
      }
    })();

    onCleanup(() => {
      controller.abort();
      observer.disconnect();
      disableTouchScrolling();
      terminal.dispose();
    });
  });

  return (
    <aside class="terminal-page" aria-label="Server logs">
      <div class="terminal-page__resizer" role="separator" aria-label="Resize terminal pane" aria-orientation="vertical" aria-valuemin="360" aria-valuemax="760" aria-valuenow={props.width} onPointerDown={props.onResizeStart} />
      <header class="terminal-page__header">
        <Button size="icon" variant="ghost" class="terminal-page__close terminal-page__close--pane" aria-label="Close logs" onClick={props.onClose}><X size={17} /></Button>
        <Button size="icon" variant="ghost" class="terminal-page__close terminal-page__close--fullscreen" aria-label="Back to dashboard" onClick={props.onClose}><ArrowLeft size={17} /></Button>
        <div class="terminal-page__identity">
          <div><strong>{props.selection.script.script}</strong><span>{worktreeLabel()}</span></div>
        </div>
        <span class="terminal-page__live"><i />{connectionLabel()}</span>
      </header>
      <div class="terminal-page__body" ref={container} />
    </aside>
  );
}

function enableTouchScrolling(container: HTMLElement, terminal: Terminal): () => void {
  const DRAG_THRESHOLD = 6;
  const MIN_MOMENTUM_VELOCITY = 0.02;
  const MOMENTUM_FRICTION = 0.94;
  let lastY: number | null = null;
  let startY: number | null = null;
  let lastTime = 0;
  let velocity = 0;
  let remainingPixels = 0;
  let dragging = false;
  let momentumFrame: number | null = null;

  const stopMomentum = () => {
    if (momentumFrame !== null) cancelAnimationFrame(momentumFrame);
    momentumFrame = null;
  };
  const reset = () => {
    stopMomentum();
    lastY = null;
    startY = null;
    lastTime = 0;
    velocity = 0;
    remainingPixels = 0;
    dragging = false;
  };
  const scrollPixels = (pixels: number): boolean => {
    remainingPixels += pixels;
    const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
    const rowHeight = (screen?.getBoundingClientRect().height ?? 0) / terminal.rows;
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return false;

    const rows = Math.trunc(remainingPixels / rowHeight);
    if (rows === 0) return true;
    const before = terminal.buffer.active.viewportY;
    terminal.scrollLines(rows);
    remainingPixels -= rows * rowHeight;
    return terminal.buffer.active.viewportY !== before;
  };
  const startMomentum = () => {
    if (Math.abs(velocity) < MIN_MOMENTUM_VELOCITY) {
      remainingPixels = 0;
      return;
    }
    let previousTime = performance.now();
    const step = (time: number) => {
      const elapsed = Math.min(32, time - previousTime);
      previousTime = time;
      if (!scrollPixels(velocity * elapsed)) {
        reset();
        return;
      }
      velocity *= Math.pow(MOMENTUM_FRICTION, elapsed / (1000 / 60));
      if (Math.abs(velocity) < MIN_MOMENTUM_VELOCITY) {
        reset();
        return;
      }
      momentumFrame = requestAnimationFrame(step);
    };
    momentumFrame = requestAnimationFrame(step);
  };
  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      reset();
      return;
    }
    stopMomentum();
    lastY = event.touches[0]!.clientY;
    startY = lastY;
    lastTime = event.timeStamp;
    velocity = 0;
    remainingPixels = 0;
    dragging = false;
  };
  const move = (event: TouchEvent) => {
    if (lastY === null || startY === null || event.touches.length !== 1) return;

    const currentY = event.touches[0]!.clientY;
    if (!dragging) {
      const selection = document.getSelection();
      if (terminal.hasSelection() || (selection && !selection.isCollapsed)) {
        lastY = currentY;
        return;
      }
      if (Math.abs(currentY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      terminal.clearSelection();
    }
    event.preventDefault();

    const elapsed = Math.max(1, event.timeStamp - lastTime);
    const pixels = lastY - currentY;
    const instantaneousVelocity = pixels / elapsed;
    velocity = velocity === 0 ? instantaneousVelocity : velocity * 0.65 + instantaneousVelocity * 0.35;
    lastY = currentY;
    lastTime = event.timeStamp;
    scrollPixels(pixels);
  };
  const end = (event: TouchEvent) => {
    if (event.touches.length !== 0) return;
    lastY = null;
    startY = null;
    lastTime = 0;
    if (dragging) startMomentum();
    else reset();
  };

  container.addEventListener("touchstart", start, { passive: true });
  container.addEventListener("touchmove", move, { passive: false });
  container.addEventListener("touchend", end, { passive: true });
  container.addEventListener("touchcancel", reset, { passive: true });

  return () => {
    container.removeEventListener("touchstart", start);
    container.removeEventListener("touchmove", move);
    container.removeEventListener("touchend", end);
    container.removeEventListener("touchcancel", reset);
  };
}
