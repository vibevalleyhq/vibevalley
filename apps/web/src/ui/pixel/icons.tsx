// No line icons and no characters attention in for icons: the pixel font has no ✓, ✗ or ›.

import type { JSX } from "@solidjs/web";
import { createSignal, Match, onSettled, Show, Switch } from "solid-js";

import type { Phase, SessionAction } from "@vibevalley/protocol";

import { useInterval } from "@/base/timer";

/** A drawing from apps/web/public/pixel; decorative unless it has a label. */
export function SpriteIcon(props: { name: string; size: number; label?: string; class?: JSX.ClassValue; style?: JSX.CSSProperties }) {
  return (
    <img
      src={`/pixel/${props.name}.png`}
      width={props.size}
      height={props.size}
      alt={props.label ?? ""}
      aria-hidden={props.label ? undefined : "true"}
      draggable="false"
      class={["inline-block shrink-0 object-contain [image-rendering:pixelated]", props.class]}
      style={{ width: `${props.size}px`, height: `${props.size}px`, ...props.style }}
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
      <Match when={props.phase._tag === "arriving"}>
        <SpriteIcon name="icon-seeds" size={size()} />
      </Match>
      <Match when={props.phase._tag === "working" && doing() === "none"}>
        <span class="inline-block shrink-0" style={{ width: `${size()}px`, height: `${size()}px` }} />
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
  return <span class={["inline-flex shrink-0", { "-translate-y-px": up() }]}>{props.children}</span>;
}

/** A sprite before a line, at its first line's height. */
export function Marked(props: { mark: string; children: JSX.Element; size?: number; top?: number }) {
  return (
    <span class="inline-flex min-w-0 items-start gap-1.5">
      <SpriteIcon name={props.mark} size={props.size ?? 12} style={{ "margin-top": `${props.top ?? 2}px` }} />
      <span class="min-w-0">{props.children}</span>
    </span>
  );
}
