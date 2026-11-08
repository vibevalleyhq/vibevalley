import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createModal } from "./Dialog";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

const recipeStyles3 = stylex.create({
  lightboxDialog: {
    margin: "auto",
    width: "100%",
    height: "100%",
    maxHeight: "none",
    maxWidth: "none",
    animationName: {
      default: "fade-in",
      "@media (prefers-reduced-motion: reduce)": "none",
      "::backdrop": "fade-in",
    },
    animationDuration: {
      default: ".18s",
      "::backdrop": ".18s",
    },
    animationDelay: {
      default: "0s",
      "::backdrop": "0s",
    },
    animationTimingFunction: {
      default: "var(--ease-out)",
      "::backdrop": "var(--ease-out)",
    },
    animationIterationCount: {
      default: "1",
      "::backdrop": "1",
    },
    animationDirection: {
      default: "normal",
      "::backdrop": "normal",
    },
    animationFillMode: {
      default: "both",
      "::backdrop": "both",
    },
    animationPlayState: {
      default: "running",
      "::backdrop": "running",
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
});

const recipeStyles2 = stylex.create({
  lightboxImg: {
    pointerEvents: "auto",
    maxHeight: "calc(100% - 4rem)",
    maxWidth: "100%",
    animationName: { default: "pop-in", "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: ".28s",
    animationDelay: "0s",
    animationTimingFunction: "var(--ease-out)",
    animationIterationCount: "1",
    animationDirection: "normal",
    animationFillMode: "both",
    animationPlayState: "running",
    borderRadius: "var(--radius-lg)",
    objectFit: "contain",
    boxShadow: "var(--shadow-float)",
  },
});

const recipeStyles = stylex.create({
  lightboxA: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
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
    transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".12s",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-selected)",
      },
    },
  },
});

const viewStyles = stylex.create({
  lightboxDiv: {
    pointerEvents: "none",
    display: "flex",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "calc(var(--spacing) * 3)",
    padding: "calc(var(--spacing) * 6)",
  },
  lightboxDiv2: {
    pointerEvents: "auto",
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-page)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-ink)",
    boxShadow: "var(--shadow-float)",
  },
  lightboxSpan: {
    paddingInline: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  lightboxSpan2: {
    maxWidth: "calc(var(--spacing) * 72)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    paddingInline: "var(--spacing)",
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
      {...stylex.attrs(recipeStyles3.lightboxDialog)}
    >
      <Show when={shown()}>
        {(p) => (
          <div {...stylex.attrs(viewStyles.lightboxDiv)} onClick={() => props.onAt(undefined)}>
            <img src={p().src} alt={p().name} {...stylex.attrs(recipeStyles2.lightboxImg)} onClick={(e) => e.stopPropagation()} />
            <div {...stylex.attrs(viewStyles.lightboxDiv2)} onClick={(e) => e.stopPropagation()}>
              <Show when={count() > 1}>
                <IconButton icon="previous" label={t("web.base.lightbox.prev")} onClick={() => go(-1)} />
                <span {...stylex.attrs(viewStyles.lightboxSpan)}>
                  {(props.at ?? 0) + 1} / {count()}
                </span>
                <IconButton icon="next" label={t("web.base.lightbox.next")} onClick={() => go(1)} />
              </Show>
              <span {...stylex.attrs(viewStyles.lightboxSpan2)}>{p().name}</span>
              {/* The file itself, not a page of the workbench: a plain link to a new tab. */}
              <a
                href={p().src}
                target="_blank"
                rel="noreferrer"
                data-testid="lightbox-original"
                aria-label={t("web.base.lightbox.original")}
                title={t("web.base.lightbox.original")}
                {...stylex.attrs(recipeStyles.lightboxA)}
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
