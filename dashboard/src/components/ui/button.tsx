import { splitProps, type JSX } from "solid-js";

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
};

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["class", "variant", "size", "children"]);
  return (
    <button
      class={`ui-button ui-button--${local.variant ?? "outline"} ui-button--${local.size ?? "md"} ${local.class ?? ""}`}
      {...rest}
    >
      {local.children}
    </button>
  );
}
