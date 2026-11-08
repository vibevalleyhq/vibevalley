import * as stylex from "@stylexjs/stylex";

import { t } from "@vibevalley/i18n";
import type { RuntimeInfo } from "@vibevalley/protocol";

import { ready, useRuntimes, useSprites } from "#/infra/query.ts";

const viewStyles = stylex.create({
  runtimeBadgeImg: {
    height: "100%",
    width: "100%",
    objectFit: "contain",
    padding: "1px",
    imageRendering: "pixelated",
  },
});

/** The catalog's label for it; the runtime's id when the catalog does not list it. */
export const runtimeName = (catalog: readonly RuntimeInfo[], runtime: string) => catalog.find((r) => r.id === runtime)?.preset.label ?? runtime;

/** The execution tool named by a profile or session, using the server's catalog label. */
export function RuntimeBadge(props: { runtime: string; size: number }) {
  const runtimes = useRuntimes();
  const sprites = useSprites();
  const label = () => t("web.base.runtime", { name: runtimeName(ready(runtimes, []), props.runtime) });
  const icon = () => {
    const name = `logo-${props.runtime}`;
    return name in ready(sprites, {}) ? name : "icon-wrench";
  };
  return (
    <span
      class="ring-bark-300/70 absolute -right-0.5 -bottom-0.5 z-10 inline-flex items-center justify-center rounded-xs bg-cream-50 ring-1"
      style={{ width: `${props.size}px`, height: `${props.size}px` }}
      role="img"
      aria-label={label()}
      title={label()}
      data-runtime={props.runtime}
    >
      <img src={`/pixel/${icon()}.png`} alt="" draggable="false" {...stylex.attrs(viewStyles.runtimeBadgeImg)} />
    </span>
  );
}
