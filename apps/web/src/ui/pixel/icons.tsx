import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, Match, onSettled, Show, Switch } from "solid-js";

import type { Phase, SessionAction } from "@vibevalley/protocol";

import { useInterval } from "#/base/timer.ts";
import { styleProps } from "#/ui/positioner.ts";

const styles = stylex.create({
  bob: {
    display: "inline-flex",
    flexShrink: "0",
  },
  bobUp: {
    translate: "0 -1px",
  },
  sprite: {
    display: "inline-block",
    flexShrink: 0,
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  size: (size: number) => ({ width: size, height: size }),
  phasePlaceholder: {
    display: "inline-block",
    flexShrink: "0",
  },
  marked: {
    display: "inline-flex",
    minWidth: "0",
    alignItems: "flex-start",
    gap: "0.375rem",
  },
  markedIcon: (marginTop: number) => ({
    marginTop,
  }),
  markedBody: {
    minWidth: "0",
  },
});

/** A drawing from apps/web/public/pixel; decorative unless it has a label. */
export function SpriteIcon(props: { name: string; size: number; label?: string; styles?: stylex.StyleXStyles; style?: JSX.CSSProperties }) {
  return (
    <img
      src={`/pixel/${props.name}.png`}
      width={props.size}
      height={props.size}
      alt={props.label ?? ""}
      aria-hidden={props.label ? undefined : "true"}
      draggable="false"
      {...styleProps([styles.sprite, props.styles, styles.size(props.size)], props.style)}
    />
  );
}

export function ActionGlyph(props: { action: SessionAction; size?: number }) {
  return (
    <Show when={props.action !== "none"}>
      <SpriteIcon name={`act-${props.action}`} size={props.size ?? 16} />
    </Show>
  );
}

export function PhaseGlyph(props: { phase: Phase; size?: number }) {
  const size = () => props.size ?? 16;
  const doing = () => (props.phase._tag === "working" ? props.phase.doing.action : undefined);
  const closed = () => (props.phase._tag === "closed" ? props.phase.closed : undefined);
  return (
    <Switch>
      <Match when={props.phase._tag === "working" && doing() === "none"}>
        <span {...styleProps([styles.phasePlaceholder, styles.size(size())])} />
      </Match>
      <Match when={props.phase._tag === "working"}>
        <Bob>
          <SpriteIcon name={`act-${doing()}`} size={size()} />
        </Bob>
      </Match>
      <Match when={props.phase._tag === "done"}>
        <SpriteIcon name="icon-harvest" size={size()} />
      </Match>
      <Match when={props.phase._tag === "failed"}>
        <SpriteIcon name="icon-bug" size={size()} />
      </Match>
      <Match when={props.phase._tag === "resting"}>
        <SpriteIcon name="act-wait" size={size()} />
      </Match>
      <Match when={props.phase._tag === "closed"}>
        <SpriteIcon name={closed() === "merged" ? "icon-harvest" : "act-wait"} size={size()} />
      </Match>
    </Switch>
  );
}

/** Whether the system asks for less motion; it follows the setting while mounted. */
export function reducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = createSignal(typeof matchMedia === "function" && matchMedia(query).matches);
  onSettled(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  });
  return reduced;
}

/** Two frames, no tween, so the pixels stay whole; still when the system asks for less motion. */
function Bob(props: { children: JSX.Element }) {
  const still = reducedMotion();
  const [up, setUp] = createSignal(false);
  useInterval(() => setUp((u) => !still() && !u), 450);
  return <span {...stylex.attrs(styles.bob, up() && styles.bobUp)}>{props.children}</span>;
}

/** A sprite before a line, at its first line's height. */
export function Marked(props: { mark: string; children: JSX.Element; size?: number; top?: number }) {
  return (
    <span {...stylex.attrs(styles.marked)}>
      <SpriteIcon name={props.mark} size={props.size ?? 12} styles={styles.markedIcon(props.top ?? 2)} />
      <span {...stylex.attrs(styles.markedBody)}>{props.children}</span>
    </span>
  );
}
