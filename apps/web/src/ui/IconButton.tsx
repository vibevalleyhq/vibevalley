import { A } from "./A";
import { Icon, type IconSize } from "./Icon";
import type { IconName } from "./icons";
import { Tip } from "./Tip";

/** A button that is only its icon: its label is what hovering shows and what a screen reader says. */
export function IconButton(props: {
  icon: IconName;
  label: string;
  onClick: () => void;
  size?: IconSize;
  tone?: "danger" | undefined;
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
          "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-[background-color,color,translate] duration-120 hover:bg-selected active:translate-y-px disabled:cursor-default disabled:opacity-50 disabled:active:translate-y-0",
          props.tone === "danger" ? "text-berry" : "text-muted hover:text-ink",
          { "bg-selected": props.pressed === true },
        ]}
      >
        <Icon name={props.icon} size={props.size ?? 16} />
      </button>
    </Tip>
  );
}

/** A link out to another site, in a new tab, that says where it goes: beside a field, where an icon alone would not. */
export function OutLink(props: { href: string; label: string }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      class="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs whitespace-nowrap text-muted hover:text-ink"
    >
      {props.label}
      <Icon name="open" size={12} />
    </a>
  );
}

/** A link that is only its icon, to a page of the workbench. A link out to another site says where it goes (OutLink):
 * the address type keeps one from being drawn as an icon alone. */
export function IconLink(props: { href: `/${string}`; label: string; icon?: IconName }) {
  return (
    <Tip text={props.label}>
      <A
        href={props.href}
        aria-label={props.label}
        class="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-selected hover:text-ink"
      >
        <Icon name={props.icon ?? "open"} size={16} />
      </A>
    </Tip>
  );
}
