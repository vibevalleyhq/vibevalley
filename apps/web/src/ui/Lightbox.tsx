import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createModal } from "./Dialog";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

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
    backgroundColor: "var(--wb-page)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-ink)",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, 0 8px 24px var(--wb-float)",
  },
  lightboxSpan: {
    paddingInline: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
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
      class="m-auto size-full max-h-none max-w-none animate-fade-in bg-transparent p-0 backdrop:animate-fade-in backdrop:bg-scrim backdrop:backdrop-blur-sm"
    >
      <Show when={shown()}>
        {(p) => (
          <div {...stylex.attrs(viewStyles.lightboxDiv)} onClick={() => props.onAt(undefined)}>
            <img
              src={p().src}
              alt={p().name}
              class="pointer-events-auto max-h-[calc(100%-4rem)] max-w-full animate-pop-in rounded-lg object-contain shadow-float"
              onClick={(e) => e.stopPropagation()}
            />
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
                class="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors duration-120 hover:bg-selected hover:text-ink"
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
