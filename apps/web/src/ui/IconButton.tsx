import { Show } from "solid-js";
import { A } from "./A";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { Tip } from "./Tip";

/** A button that is only its icon: its label is what hovering shows and what a screen reader says. */
export function IconButton(props: {
  icon: IconName;
  label: string;
  onClick: () => void;
  size?: number;
  tone?: "danger";
  pressed?: boolean;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <Tip text={props.label}>
      <button
        type="button"
        data-testid={props.testid}
        aria-label={props.label}
        aria-pressed={props.pressed === undefined ? undefined : props.pressed ? "true" : "false"}
        disabled={props.disabled}
        onClick={() => props.onClick()}
        class={[
          "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-selected disabled:cursor-default disabled:opacity-40",
          props.tone === "danger" ? "text-berry" : "text-muted hover:text-ink",
          { "bg-selected": props.pressed === true },
        ]}
      >
        <Icon name={props.icon} size={props.size ?? 16} />
      </button>
    </Tip>
  );
}

/** A link that is only its icon: out to another site in a new tab, or a page of the workbench. */
export function IconLink(props: { href: string; label: string; icon?: IconName }) {
  const look = "inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-selected hover:text-ink";
  return (
    <Tip text={props.label}>
      <Show
        when={/^https?:/.test(props.href)}
        fallback={
          <A href={props.href} aria-label={props.label} class={look}>
            <Icon name={props.icon ?? "open"} size={16} />
          </A>
        }
      >
        <a href={props.href} target="_blank" rel="noreferrer" aria-label={props.label} class={look}>
          <Icon name={props.icon ?? "open"} size={16} />
        </a>
      </Show>
    </Tip>
  );
}
