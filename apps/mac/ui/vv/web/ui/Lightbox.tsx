// Ported from VibeValley apps/web/src/ui/Lightbox.tsx: pictures over the
// page, one at a time, with the previous and next (also ← →), the name, the
// original and close. nsh/base's Dialog is the <dialog> (Escape and a press
// on the backdrop close it). The original opens in the system's app
// (host.openFile) where VibeValley opens a browser tab, so a picture here
// carries its file's path. A picture is shown a point per pixel, as the
// browser shows it, fitted to the window. The backdrop's blur is not ported
// (GPUI draws no backdrop filter).
import { Image, keymap, signal, Text, View, windowSize } from "nsh";
import { Dialog } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { hostApi } from "../../../bridge";
import { createEffect } from "../../solid";
import { IconButton } from "./IconButton";

export interface Picture {
  readonly src: string;
  readonly name: string;
  /** The file on disk, for "open the original". */
  readonly path?: string;
}

/** Pictures over the page, one at a time (docs/style/design.md); the original opens in the system's app. */
export function Lightbox(props: { pictures: readonly Picture[]; at: number | undefined; onAt: (at: number | undefined) => void }) {
  const count = () => props.pictures.length;
  const go = (step: number) => {
    if (props.at === undefined || count() < 2) return;
    props.onAt((props.at + step + count()) % count());
  };
  keymap.bind({ left: () => go(-1), right: () => go(1) }, { passThrough: true });
  const shown = () => (props.at === undefined ? undefined : props.pictures[props.at]);
  // An Image takes no size from its picture: the picture's own, scaled down to the window (less the bar), never up.
  const natural = signal<{ src: string; width: number; height: number } | undefined>(undefined);
  createEffect(
    () => shown()?.src,
    (src) => {
      if (src === undefined) return;
      void Image.getSize(src).then(
        (size) => natural.set({ src, width: size.width, height: size.height }),
        () => natural.set(undefined),
      );
    },
  );
  const fit = () => {
    const n = natural();
    const boxW = windowSize().width - 48;
    const boxH = windowSize().height - 112;
    if (!n || n.src !== shown()?.src) return { width: Math.min(boxW, 480), height: Math.min(boxH, 320) };
    const k = Math.min(1, boxW / n.width, boxH / n.height);
    return { width: n.width * k, height: n.height * k };
  };
  return (
    <Dialog
      open={props.at !== undefined}
      testID="lightbox"
      accessibilityLabel={shown()?.name ?? t("web.base.lightbox.label")}
      animation="fade"
      onOpenChange={(e) => !e.open && props.onAt(undefined)}
      backdropClass="bg-scrim"
      class="m-auto items-center justify-center gap-3"
    >
      <If when={shown()}>
        {(p) => (
          <>
            <Image src={p().src} accessibilityLabel={p().name} class="rounded-lg shadow-float" style={{ ...fit(), objectFit: "contain" }} />
            <View class="flex-row items-center gap-1 rounded-lg bg-page px-2 py-1 shadow-float">
              <If when={count() > 1}>
                <IconButton icon="previous" label={t("web.base.lightbox.prev")} onClick={() => go(-1)} testid="lightbox-prev" />
                <Text class="px-1 text-xs text-muted">{`${(props.at ?? 0) + 1} / ${count()}`}</Text>
                <IconButton icon="next" label={t("web.base.lightbox.next")} onClick={() => go(1)} testid="lightbox-next" />
              </If>
              <Text testID="lightbox-name" class="max-w-72 truncate px-1 text-sm text-ink">
                {p().name}
              </Text>
              <If when={p().path}>
                {(path) => (
                  <IconButton icon="open" label={t("web.base.lightbox.original")} onClick={() => void hostApi.openFile(path())} testid="lightbox-original" />
                )}
              </If>
              <IconButton icon="close" label={t("web.base.lightbox.close")} onClick={() => props.onAt(undefined)} testid="lightbox-close" />
            </View>
          </>
        )}
      </If>
    </Dialog>
  );
}
