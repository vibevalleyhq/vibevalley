import { t } from "@vibevalley/i18n";
import { Show } from "solid-js";
import { createModal } from "./modal";
import { IconButton } from "./IconButton";
import { Icon } from "./Icon";

export interface Picture {
  readonly src: string;
  readonly name: string;
}

/**
 * Pictures over the page, one at a time (docs/style/design.md, 附件): it grows in from where the picture was, ← and →
 * go through the others of the same message, Escape or a click beside the picture closes it; the original opens in a tab.
 * at: the one shown, or none while closed.
 */
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
          <div class="pointer-events-none flex size-full flex-col items-center justify-center gap-3 p-6" onClick={() => props.onAt(undefined)}>
            <img
              src={p().src}
              alt={p().name}
              class="pointer-events-auto max-h-[calc(100%-4rem)] max-w-full animate-pop-in rounded-lg object-contain shadow-float"
              onClick={(e) => e.stopPropagation()}
            />
            <div
              class="pointer-events-auto flex items-center gap-1 rounded-lg bg-page px-2 py-1 text-sm text-ink shadow-float"
              onClick={(e) => e.stopPropagation()}
            >
              <Show when={count() > 1}>
                <IconButton icon="previous" label={t("web.base.lightbox.prev")} onClick={() => go(-1)} />
                <span class="px-1 text-xs text-muted">
                  {props.at! + 1} / {count()}
                </span>
                <IconButton icon="next" label={t("web.base.lightbox.next")} onClick={() => go(1)} />
              </Show>
              <span class="max-w-72 truncate px-1">{p().name}</span>
              {/* The file itself, not a page of the workbench: a plain link to a new tab. */}
              <a
                href={p().src}
                target="_blank"
                rel="noreferrer"
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
