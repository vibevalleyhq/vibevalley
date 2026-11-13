// Ported from VibeValley apps/web/src/ui/pixel/icons.tsx. A sprite is an
// nsh Image of its PNG (ui/pixel/atlas.ts); until the app said where the
// art is, the box stays empty at the same size. nsh scales the small PNGs
// up crisp enough at these sizes, so there is no image-rendering here.
// reducedMotion is nsh's reduceMotion.
import { Image, reduceMotion, signal, View, type JSX, type ViewStyle } from "nsh";

import type { Phase, SessionAction } from "@vibevalley/protocol";

import { useInterval } from "../../base/timer";
import { usePixelDir, useSpriteUrl } from "./atlas";
import { spriteManifest } from "./manifests";

/** A drawing from VibeValley's apps/web/public/pixel; decorative unless it has a label. */
export function SpriteIcon(props: { name: string; size: number; label?: string; style?: ViewStyle; testID?: string }) {
  const url = useSpriteUrl();
  return (
    <View
      testID={props.testID}
      role={props.label ? "image" : undefined}
      accessibilityLabel={props.label}
      style={{ ...props.style, width: props.size, height: props.size, flexShrink: 0 }}
    >
      <If when={url(props.name)}>{(src) => <Image src={src()} style={{ width: props.size, height: props.size, objectFit: "contain" }} />}</If>
    </View>
  );
}

export function ActionGlyph(props: { action: SessionAction; size?: number }) {
  return (
    <If when={props.action !== "none"}>
      <SpriteIcon name={`act-${props.action}`} size={props.size ?? 16} />
    </If>
  );
}

export function PhaseGlyph(props: { phase: Phase; size?: number }) {
  const size = () => props.size ?? 16;
  const doing = () => (props.phase._tag === "working" ? props.phase.doing.action : undefined);
  const name = (): string | undefined => {
    const p = props.phase;
    if (p._tag === "working") return doing() === "none" ? undefined : `act-${doing()}`;
    if (p._tag === "done") return "icon-harvest";
    if (p._tag === "failed") return "icon-bug";
    if (p._tag === "resting") return "act-wait";
    if (p._tag === "closed") return p.closed === "merged" ? "icon-harvest" : "act-wait";
    return undefined;
  };
  return (
    <If when={name()} else={<View style={{ width: size(), height: size(), flexShrink: 0 }} />}>
      {(n) => (
        <If when={props.phase._tag === "working"} else={<SpriteIcon name={n()} size={size()} />}>
          <Bob>
            <SpriteIcon name={n()} size={size()} />
          </Bob>
        </If>
      )}
    </If>
  );
}

/** Two frames, no tween, so the pixels stay whole; still when the system asks for less motion. */
function Bob(props: { children: JSX.Element }) {
  const up = signal(false);
  useInterval(() => up.set(!reduceMotion() && !up()), 450);
  return <View style={{ flexShrink: 0, transform: [{ translateY: up() ? -1 : 0 }] }}>{props.children}</View>;
}

/** A sprite before a line, at its first line's height. */
export function Marked(props: { mark: string; children: JSX.Element; size?: number; top?: number }) {
  return (
    <View class="min-w-0 flex-row items-start gap-1.5">
      <SpriteIcon name={props.mark} size={props.size ?? 12} style={{ marginTop: props.top ?? 2 }} />
      <View class="min-w-0">{props.children}</View>
    </View>
  );
}

/** The sprite when the art is there and has `name`, else `children` (a stand-in drawn without the art). */
export function SpriteOr(props: { name: string; size: number; label?: string; testID?: string; children: JSX.Element }) {
  const dir = usePixelDir();
  const has = () => dir() !== undefined && props.name in (spriteManifest as Record<string, unknown>);
  return (
    <If when={has()} else={props.children}>
      <SpriteIcon name={props.name} size={props.size} label={props.label} testID={props.testID} />
    </If>
  );
}
