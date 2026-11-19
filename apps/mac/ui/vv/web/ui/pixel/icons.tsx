// Ported from VibeValley apps/web/src/ui/pixel/icons.tsx. A sprite is an
// nsh Image of its PNG (ui/pixel/atlas.ts); until the app said where the
// art is, the box stays empty at the same size. nsh scales the small PNGs
// up crisp enough at these sizes, so there is no image-rendering here.
// reducedMotion is nsh's reduceMotion.
import { Image, View, type JSX, type ViewStyle } from "nsh";

import { ready, useSprites } from "../../infra/query";
import { usePixelDir, useSpriteUrl } from "./atlas";

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

/** The sprite when the art is there and has `name`, else `children` (a stand-in drawn without the art). */
export function SpriteOr(props: { name: string; size: number; label?: string; testID?: string; children: JSX.Element }) {
  const dir = usePixelDir();
  const sprites = useSprites();
  const has = () => {
    if (dir() === undefined) return false;
    const manifest = ready(sprites, undefined);
    return manifest !== undefined && Object.hasOwn(manifest, props.name);
  };
  return (
    <If when={has()} else={props.children}>
      <SpriteIcon name={props.name} size={props.size} label={props.label} testID={props.testID} />
    </If>
  );
}
