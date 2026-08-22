import type { JSX } from "solid-js";

export function Badge(props: { tone?: "neutral" | "success" | "warning" | "info"; children: JSX.Element }) {
  return <span class={`ui-badge ui-badge--${props.tone ?? "neutral"}`}>{props.children}</span>;
}
