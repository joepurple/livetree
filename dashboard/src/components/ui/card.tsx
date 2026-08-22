import type { JSX } from "solid-js";

export function Card(props: { class?: string; children: JSX.Element }) {
  return <section class={`ui-card ${props.class ?? ""}`}>{props.children}</section>;
}
