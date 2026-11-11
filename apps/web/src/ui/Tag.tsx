import * as stylex from "@stylexjs/stylex";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { styleProps } from "./positioner";

/** What a tag says by its colour: done or new (ok), failed (bad), sent or stopped (wait). Its ink comes with it, so it
 * reads in both themes. */
export type TagTone = "ok" | "bad" | "wait";

const styles = stylex.create({
  tag: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    borderRadius: "var(--radius-sm)",
    paddingInline: "0.375rem",
    paddingBlock: "1px",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-medium)",
  },
  ok: { backgroundColor: "var(--color-ok-soft)", color: "var(--color-ok-ink)" },
  bad: { backgroundColor: "var(--color-bad-soft)", color: "var(--color-berry)" },
  wait: {
    backgroundColor: {
      default: "var(--color-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-wheat) 25%, transparent)",
    },
    color: "var(--color-ink)",
  },
  dot: { display: "inline-block", flexShrink: 0, borderRadius: "9999px" },
  size: (size: number) => ({ width: size, height: size }),
  ring: { boxShadow: "0 0 0 2px var(--color-page)" },
  leaf: { backgroundColor: "var(--color-leaf)" },
  wheat: { backgroundColor: "var(--color-wheat)" },
  berry: { backgroundColor: "var(--color-berry)" },
  water: { backgroundColor: "var(--color-water)" },
  idle: { backgroundColor: "var(--color-idle)" },
  faint: { backgroundColor: "var(--color-faint)" },
  muted: { backgroundColor: "var(--color-muted)" },
});

const tagTones: Record<TagTone, stylex.StyleXStyles> = { ok: styles.ok, bad: styles.bad, wait: styles.wait };

export function Tag(props: { icon?: IconName | undefined; label: string; tone: TagTone }) {
  return (
    <span {...stylex.attrs(styles.tag, tagTones[props.tone])}>
      {props.icon && <Icon name={props.icon} size={12} />}
      {props.label}
    </span>
  );
}

/** What a dot says (docs/style/design.md). */
export type DotTone = "leaf" | "wheat" | "berry" | "water" | "idle" | "faint" | "muted";

const dotColor: Record<DotTone, stylex.StyleXStyles> = {
  leaf: styles.leaf,
  wheat: styles.wheat,
  berry: styles.berry,
  water: styles.water,
  idle: styles.idle,
  faint: styles.faint,
  muted: styles.muted,
};

/** A round status dot. ring: drawn on a face or a picture, it is ringed in the page colour to stand off it. */
export function Dot(props: { tone: DotTone; size?: number; ring?: boolean; styles?: stylex.StyleXStyles }) {
  return (
    <span
      {...styleProps([styles.dot, dotColor[props.tone], props.ring !== false && styles.ring, props.styles, styles.size(props.size ?? 9)])}
      aria-hidden="true"
    />
  );
}
