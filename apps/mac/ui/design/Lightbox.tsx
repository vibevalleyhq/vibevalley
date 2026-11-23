import { colorScheme, effect, Image, keymap, signal, Text, View, windowSize } from "nsh";
import { Dialog } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { useDesignHost } from "./host";
import { IconButton } from "./IconButton";
import { fadeAnimation } from "./motion";
import { mix } from "./tone";

export interface Picture {
  readonly src: string;
  readonly name: string;
  /** The file on disk, for "open the original". */
  readonly path?: string;
}

export function Lightbox(props: { pictures: readonly Picture[]; at: number | undefined; onAt: (at: number | undefined) => void }) {
  const designHost = useDesignHost();
  const count = () => props.pictures.length;
  const go = (step: number) => {
    if (props.at === undefined || count() < 2) return;
    props.onAt((props.at + step + count()) % count());
  };
  keymap.bind({ left: () => go(-1), right: () => go(1) }, { passThrough: true });
  const shown = () => (props.at === undefined ? undefined : props.pictures[props.at]);
  // An Image takes no size from its picture: the picture's own, scaled down to the window (less the bar), never up.
  const natural = signal<{ src: string; width: number; height: number } | undefined>(undefined);
  effect(() => {
    const src = shown()?.src;
    if (!src) {
      natural.set(undefined);
      return;
    }
    let active = true;
    void Image.getSize(src).then(
      (size) => active && natural.set({ src, width: size.width, height: size.height }),
      () => active && natural.set(undefined),
    );
    return () => {
      active = false;
    };
  });
  const fit = () => {
    const n = natural();
    const boxW = Math.max(160, windowSize().width - 64);
    const boxH = Math.max(120, windowSize().height - 136);
    if (!n || n.src !== shown()?.src) return { width: Math.min(boxW, 480), height: Math.min(boxH, 320) };
    const k = Math.min(1, boxW / n.width, boxH / n.height);
    return { width: n.width * k, height: n.height * k };
  };
  const dims = () => {
    const n = natural();
    return n && n.src === shown()?.src ? `${n.width}×${n.height}` : undefined;
  };
  return (
    <Dialog
      open={props.at !== undefined}
      testID="lightbox"
      accessibilityLabel={shown()?.name ?? t("web.base.lightbox.label")}
      animation={fadeAnimation()}
      onOpenChange={(e) => !e.open && props.onAt(undefined)}
      backdropStyle={{ backgroundColor: mix("ink-950", colorScheme() === "dark" ? 0.88 : 0.78) }}
      class="m-auto items-center justify-center gap-3"
    >
      <If when={shown()}>
        {(p) => (
          <>
            <View class="overflow-hidden rounded-lg border shadow-float" style={{ borderColor: mix("white", 0.14), backgroundColor: mix("ink-950", 0.45) }}>
              <Image src={p().src} accessibilityLabel={p().name} style={{ ...fit(), objectFit: "contain" }} />
            </View>
            <View class="flex-row items-center gap-1 rounded-lg border border-line bg-elevated px-2.5 py-1.5 shadow-float">
              <If when={count() > 1}>
                <IconButton icon="previous" size={14} label={t("web.base.lightbox.prev")} onClick={() => go(-1)} testid="lightbox-prev" />
                <Text class="min-w-10 px-1 text-center font-mono text-xs font-medium text-muted tabular-nums">{`${(props.at ?? 0) + 1} / ${count()}`}</Text>
                <IconButton icon="next" size={14} label={t("web.base.lightbox.next")} onClick={() => go(1)} testid="lightbox-next" />
                <View class="mx-1 h-4 w-px bg-line" />
              </If>
              <Text testID="lightbox-name" class="max-w-72 truncate px-1.5 text-sm font-medium text-ink">
                {p().name}
              </Text>
              <If when={dims()}>{(size) => <Text class="shrink-0 pr-1 font-mono text-2xs text-faint tabular-nums">{size()}</Text>}</If>
              <View class="mx-1 h-4 w-px bg-line" />
              <If when={p().path}>
                {(path) => (
                  <>
                    <IconButton
                      icon="open"
                      size={14}
                      label={t("web.base.lightbox.original")}
                      onClick={() => void designHost.openFile(path())}
                      testid="lightbox-original"
                    />
                    <IconButton
                      icon="download"
                      size={14}
                      label={t("web.base.form.save")}
                      onClick={() => void designHost.saveFile(path(), p().name).catch((e: unknown) => designHost.toast(designHost.formatError(e), "bad"))}
                      testid="lightbox-save"
                    />
                  </>
                )}
              </If>
              <IconButton icon="close" size={14} label={t("web.base.lightbox.close")} onClick={() => props.onAt(undefined)} testid="lightbox-close" />
            </View>
          </>
        )}
      </If>
    </Dialog>
  );
}
