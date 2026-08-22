import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowLeft } from "lucide-solid";
import { createSignal, onCleanup, onMount } from "solid-js";
import { Button } from "./components/ui/button";
import type { LogSelection } from "./types";

export function TerminalPage(props: { selection: LogSelection; onClose: () => void }) {
  let container!: HTMLDivElement;
  const [connectionLabel, setConnectionLabel] = createSignal("Connecting");

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
        cursor: "#8ee8b0",
        selectionBackground: "#315640",
        black: "#1d2228",
        green: "#78d99c",
        brightGreen: "#a5f3bf",
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
    <main class="terminal-page" aria-label="Server logs">
      <header class="terminal-page__header">
        <Button size="sm" variant="ghost" aria-label="Back to dashboard" onClick={props.onClose}>
          <ArrowLeft size={16} />Back
        </Button>
        <div class="terminal-page__identity">
          <span class="terminal-page__lights" aria-hidden="true"><i /><i /><i /></span>
          <div><strong>{props.selection.script.script}</strong><span>{props.selection.worktree.label}</span></div>
        </div>
        <span class="terminal-page__live"><i />{connectionLabel()}</span>
      </header>
      <div class="terminal-page__body" ref={container} />
    </main>
  );
}
