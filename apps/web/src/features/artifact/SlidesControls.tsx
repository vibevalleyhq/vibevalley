import { createEffect, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { shownTheme } from "#/state/prefs.ts";
import { IconButton } from "#/ui/IconButton.tsx";

import { type Controls, sendTo } from "./frame";
import { shellPath } from "./shell";
import { presenterHref, slidePostOf, slidesChannelName, stepped } from "./slides";

/** A deck's controls: step, the slide's title, thumbnails, the whole screen, the speaker's window and the PDF. The speaker's
 * window and this one follow each other. */
export function SlidesControls(props: Controls) {
  const pages = () => props.shown().ready?.pages ?? 0;
  const at = () => props.shown().at?.page ?? 0;
  const slideNumbers = (): readonly number[] => Array.from({ length: pages() }, (_, i) => i);
  const goto = (page: number) => sendTo(props.frame())({ vibevalley: "goto", page });
  let channel: BroadcastChannel | undefined;
  onSettled(() => {
    channel = new BroadcastChannel(slidesChannelName({ id: props.artifact.id, version: props.version }));
    channel.onmessage = (e: MessageEvent) => {
      const page = slidePostOf(e.data);
      if (page !== undefined) goto(page);
    };
    return () => channel?.close();
  });
  createEffect(at, (page) => channel?.postMessage({ page }));
  const present = () => {
    const frame = props.frame();
    if (frame === undefined) return;
    void frame.requestFullscreen().then(() => frame.contentWindow?.focus());
  };
  const speaker = () =>
    window.open(presenterHref({ id: props.artifact.id, version: props.version }), `vibevalley-presenter-${props.artifact.id}`, "popup,width=1200,height=760");
  const pdf = () => window.open(shellPath(props.artifact.id, props.version, "slides", "light", { print: true }), "_blank", "noopener");
  return (
    <Show when={pages() > 0}>
      <div data-testid="slides-controls" data-at={at()} data-pages={pages()} class="flex shrink-0 flex-col gap-2 border-t border-line py-2 px-3">
        <div class="flex items-center gap-1">
          <IconButton
            icon="previous"
            label={t("web.artifact.slides.previous")}
            testid="slides-previous"
            disabled={at() === 0}
            onClick={() => goto(stepped({ at: at(), step: -1, pages: pages() }))}
          />
          <span data-testid="slides-at" class="min-w-14 text-center tabular-nums text-xs text-muted">
            {t("web.artifact.slides.at", { at: at() + 1, pages: pages() })}
          </span>
          <IconButton
            icon="next"
            label={t("web.artifact.slides.next")}
            testid="slides-next"
            disabled={at() >= pages() - 1}
            onClick={() => goto(stepped({ at: at(), step: 1, pages: pages() }))}
          />
          <span class="min-w-0 flex-1 truncate text-xs text-faint">{props.shown().ready?.titles?.[at()] ?? ""}</span>
          <IconButton icon="present" label={t("web.artifact.slides.present")} testid="slides-present" onClick={present} />
          <IconButton icon="presenter" label={t("web.artifact.slides.presenter")} testid="slides-presenter" onClick={speaker} />
          <IconButton icon="pdf" label={t("web.artifact.slides.pdf")} testid="slides-pdf" onClick={pdf} />
        </div>
        <Show when={pages() > 1}>
          <div role="group" aria-label={t("web.artifact.slides.thumbnails")} data-testid="slides-strip" class="flex gap-2 overflow-x-auto pb-1">
            <For each={slideNumbers()}>
              {(i: number) => (
                <button
                  type="button"
                  data-testid="slides-thumb"
                  data-page={i}
                  aria-current={i === at() ? "true" : undefined}
                  aria-label={t("web.artifact.slides.slide", { at: i + 1, title: props.shown().ready?.titles?.[i] ?? "" })}
                  class={[
                    "relative shrink-0 w-32 h-18 overflow-hidden p-0 cursor-pointer rounded-md border border-line hover:border-faint bg-side",
                    i === at() && "outline-solid outline-2 outline-accent outline-offset-1",
                  ]}
                  onClick={() => goto(i)}
                >
                  <iframe
                    title={t("web.artifact.slides.slide", { at: i + 1, title: props.shown().ready?.titles?.[i] ?? "" })}
                    tabindex={-1}
                    aria-hidden="true"
                    src={shellPath(props.artifact.id, props.version, "slides", shownTheme(), { at: i, still: true })}
                    sandbox={htmlSandbox}
                    referrerpolicy="no-referrer"
                    loading="lazy"
                    class="w-full h-full pointer-events-none border-0"
                  />
                  <span class="absolute top-1 right-1 rounded-sm bg-page px-1 text-xs text-muted">{i + 1}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
