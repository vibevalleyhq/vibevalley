import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createModal } from "./Dialog";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

const popIn = stylex.keyframes({
  from: { opacity: 0, scale: 0.98 },
});

const fadeIn = stylex.keyframes({
  from: { opacity: 0 },
});

const styles = stylex.create({
  dialog: {
    margin: "auto",
    width: "100%",
    height: "100%",
    maxHeight: "none",
    maxWidth: "none",
    animationName: {
      default: fadeIn,
      "@media (prefers-reduced-motion: reduce)": "none",
      "::backdrop": fadeIn,
    },
    animationDuration: {
      default: "180ms",
      "::backdrop": "180ms",
    },
    animationTimingFunction: {
      default: "var(--ease-out)",
      "::backdrop": "var(--ease-out)",
    },
    animationFillMode: {
      default: "both",
      "::backdrop": "both",
    },
    backgroundColor: {
      default: "transparent",
      "::backdrop": "var(--wb-scrim)",
    },
    padding: "0",
    WebkitBackdropFilter: {
      default: null,
      "::backdrop": "blur(var(--blur-sm))",
    },
    backdropFilter: {
      default: null,
      "::backdrop": "blur(var(--blur-sm))",
    },
  },
  picture: {
    pointerEvents: "auto",
    maxHeight: "calc(100% - 4rem)",
    maxWidth: "100%",
    animationName: { default: popIn, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "280ms",
    animationTimingFunction: "var(--ease-out)",
    animationFillMode: "both",
    borderRadius: "var(--radius-lg)",
    objectFit: "contain",
    boxShadow: "var(--shadow-float)",
  },
  openOriginal: {
    display: "inline-flex",
    width: "1.75rem",
    height: "1.75rem",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    transitionProperty: "color, background-color, border-color",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: "120ms",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-selected)",
      },
    },
  },
  stage: {
    pointerEvents: "none",
    display: "flex",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.75rem",
    padding: "1.5rem",
  },
  toolbar: {
    pointerEvents: "auto",
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-page)",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-ink)",
    boxShadow: "var(--shadow-float)",
  },
  counter: {
    paddingInline: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  caption: {
    maxWidth: "18rem",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    paddingInline: "0.25rem",
  },
});

export interface Picture {
  readonly src: string;
  readonly name: string;
}

/** Pictures over the page, one at a time (docs/style/design.md). the original opens in a tab. */
export function Lightbox(props: { pictures: readonly Picture[]; at: number | undefined; onAt: (at: number | undefined) => void }) {
  const m = createModal(
    () => props.at !== undefined,
    () => props.onAt(undefined),
  );
  const count = () => props.pictures.length;
  const go = (step: number) => {
    if (props.at === undefined || count() < 2) return;
    props.onAt((props.at + step + count()) % count());
  };
  const shown = () => (props.at === undefined ? undefined : props.pictures[props.at]);
  return (
    <dialog
      ref={m.ref}
      data-testid="lightbox"
      data-key={shown()?.name}
      aria-label={shown()?.name ?? t("web.base.lightbox.label")}
      onCancel={m.onCancel}
      onClose={m.onClose}
      onClick={m.onClick}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") go(-1);
        if (e.key === "ArrowRight") go(1);
      }}
      {...stylex.attrs(styles.dialog)}
    >
      <Show when={shown()}>
        {(p) => (
          <div {...stylex.attrs(styles.stage)} onClick={() => props.onAt(undefined)}>
            <img src={p().src} alt={p().name} {...stylex.attrs(styles.picture)} onClick={(e) => e.stopPropagation()} />
            <div {...stylex.attrs(styles.toolbar)} onClick={(e) => e.stopPropagation()}>
              <Show when={count() > 1}>
                <IconButton icon="previous" label={t("web.base.lightbox.prev")} onClick={() => go(-1)} />
                <span {...stylex.attrs(styles.counter)}>
                  {(props.at ?? 0) + 1} / {count()}
                </span>
                <IconButton icon="next" label={t("web.base.lightbox.next")} onClick={() => go(1)} />
              </Show>
              <span {...stylex.attrs(styles.caption)}>{p().name}</span>
              {/* The file itself, not a page of the workbench: a plain link to a new tab. */}
              <a
                href={p().src}
                target="_blank"
                rel="noreferrer"
                data-testid="lightbox-original"
                aria-label={t("web.base.lightbox.original")}
                title={t("web.base.lightbox.original")}
                {...stylex.attrs(styles.openOriginal)}
              >
                <Icon name="open" size={16} />
              </a>
              <IconButton icon="close" label={t("web.base.lightbox.close")} onClick={() => props.onAt(undefined)} />
            </div>
          </div>
        )}
      </Show>
    </dialog>
  );
}
