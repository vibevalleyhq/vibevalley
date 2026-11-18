// Ported from VibeValley apps/web/src/ui/domain/RuntimeBadge.tsx: the
// runtime's pixel logo (logo-<id>, else icon-wrench) from the app's art
// (ui/pixel/atlas.ts). Until the art's folder is known, the badge carries
// the first letter of the runtime's name.
import { Image, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { RuntimeInfo } from "@vibevalley/protocol";

import { ready, useRuntimes, useSprites } from "../../infra/query";
import { useSpriteUrl } from "../pixel/atlas";
import { Bubble } from "../Tip";

/** The catalog's label for it; the runtime's id when the catalog does not list it. */
export const runtimeName = (catalog: readonly RuntimeInfo[], runtime: string) => catalog.find((r) => r.id === runtime)?.preset.label ?? runtime;

/** The first letter of a name, as a face or a mark shows it while the pixel art is not there. */
export const initialOf = (name: string) => ([...name.trim()][0] ?? "?").toUpperCase();

/** The execution tool named by a profile or session, using the server's catalog label. */
export function RuntimeBadge(props: { runtime: string; size: number }) {
  const runtimes = useRuntimes();
  const sprites = useSprites();
  const url = useSpriteUrl();
  const name = () => runtimeName(ready(runtimes, []), props.runtime);
  const label = () => t("web.base.runtime", { name: name() });
  const icon = () => {
    const logo = `logo-${props.runtime}`;
    return url(logo in ready(sprites, {}) ? logo : "icon-wrench");
  };
  return (
    <View
      role="image"
      accessibilityLabel={label()}
      tooltip={<Bubble text={label()} />}
      class="absolute -right-0.5 -bottom-0.5 z-10 items-center justify-center rounded-xs border border-ink bg-cream-50"
      style={{ width: props.size, height: props.size }}
    >
      <If
        when={icon()}
        else={
          <Text class="font-semibold text-bark-900" style={{ fontSize: Math.max(7, Math.round(props.size * 0.62)), lineHeight: props.size - 2 }}>
            {initialOf(name())}
          </Text>
        }
      >
        {(src) => <Image src={src()} style={{ width: props.size - 2, height: props.size - 2, padding: 1, objectFit: "contain" }} />}
      </If>
    </View>
  );
}
