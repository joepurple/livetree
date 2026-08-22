import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowLeft, X } from "lucide-solid";
import { createSignal, onCleanup, onMount } from "solid-js";
import { Button } from "./components/ui/button";
import type { LogSelection } from "./types";

export function TerminalPage(props: { selection: LogSelection; onClose: () => void; onResizeStart: (event: PointerEvent) => void; width: number }) {
  let container!: HTMLDivElement;
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
      theme: {
        background: "#090b0e",
        foreground: "#d7ddd9",
        cursor: "#f1f3f2",
        selectionBackground: "#4a4f4c",
        black: "#1d2228",
        green: "#d7ddd9",
        brightGreen: "#ffffff",
        blue: "#75a7f8",
        brightBlue: "#a8c8ff",
        yellow: "#e6c86e",
        red: "#ef7d79",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    requestAnimationFrame(() => fit.fit());
    terminal.writeln(`\x1b[2mStreaming ${props.selection.script.script} · ${props.selection.worktree.label}\x1b[0m`);
    terminal.writeln("");

    const observer = new ResizeObserver(() => requestAnimationFrame(() => fit.fit()));
    observer.observe(container);

    const controller = new AbortController();
    const url = new URL("api/logs", document.baseURI);
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
