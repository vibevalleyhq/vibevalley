import * as stylex from "@stylexjs/stylex";

import { Link as A } from "#/infra/router.ts";

import { Icon, type IconSize } from "./Icon";
import type { IconName } from "./icons";
import { Tip } from "./Tip";

const variantStyles = stylex.create({
  iconLinkA: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-selected)",
      },
    },
  },
});

const viewStyles = stylex.create({
  button: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
    flexShrink: 0,
    cursor: { default: "pointer", ":disabled": "default" },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    transitionProperty: "background-color, color, translate",
    transitionDuration: "120ms",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    backgroundColor: { default: null, "@media (hover: hover)": { default: null, ":hover": "var(--color-selected)" } },
    translate: { default: null, ":active": { default: "0 1px", ":disabled": "0 0" } },
    opacity: { default: null, ":disabled": 0.5 },
  },
  normal: { color: { default: "var(--color-muted)", "@media (hover: hover)": { default: null, ":hover": "var(--color-ink)" } } },
  danger: { color: "var(--color-berry)" },
  pressed: { backgroundColor: "var(--color-selected)" },
  outLinkA: {
    display: "inline-flex",
    flexShrink: "0",
    alignItems: "center",
    gap: "var(--spacing)",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    whiteSpace: "nowrap",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
  },
});

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
        {...stylex.attrs(viewStyles.button, props.tone === "danger" ? viewStyles.danger : viewStyles.normal, props.pressed === true && viewStyles.pressed)}
      >
        <Icon name={props.icon} size={props.size ?? 16} />
      </button>
    </Tip>
  );
}

/** A link out to another site, in a new tab, that says where it goes: beside a field, where an icon alone would not. */
export function OutLink(props: { href: string; label: string }) {
  return (
    <a href={props.href} target="_blank" rel="noreferrer" {...stylex.attrs(viewStyles.outLinkA)}>
      {props.label}
      <Icon name="open" size={12} />
    </a>
  );
}

/** A link that is only its icon, to a page of the workbench. */
export function IconLink(props: { href: `/${string}`; label: string; icon?: IconName }) {
  return (
    <Tip text={props.label}>
      <A href={props.href} aria-label={props.label} {...stylex.attrs(variantStyles.iconLinkA)}>
        <Icon name={props.icon ?? "open"} size={16} />
      </A>
    </Tip>
  );
}
