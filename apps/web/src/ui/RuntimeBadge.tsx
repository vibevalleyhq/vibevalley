import * as stylex from "@stylexjs/stylex";

import { t } from "@vibevalley/i18n";
import type { RuntimeInfo } from "@vibevalley/protocol";

import { ready, useRuntimes, useSprites } from "#/infra/query.ts";

import { styleProps } from "./positioner";

const styles = stylex.create({
  badge: (size: number) => ({
    position: "absolute",
    right: "-0.125rem",
    bottom: "-0.125rem",
    zIndex: "10",
    display: "inline-flex",
    width: size,
    height: size,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-xs)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "0 0 0 1px currentcolor",
  }),
  img: {
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
    <span {...styleProps(styles.badge(props.size))} role="img" aria-label={label()} title={label()} data-runtime={props.runtime}>
      <img src={`/pixel/${icon()}.png`} alt="" draggable="false" {...stylex.attrs(styles.img)} />
    </span>
  );
}
