import * as stylex from "@stylexjs/stylex";
import { Array as Arr } from "effect";
import { createEffect, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { shownTheme } from "#/state/prefs.ts";
import { IconButton } from "#/ui/IconButton.tsx";

import { type Controls, sendTo } from "./frame";
import { shellPath } from "./shell";
import { presenterHref, slidePostOf, slidesChannelName, stepped } from "./slides";

const thumbWidth = 128;
const thumbHeight = 72;

const viewStyles = stylex.create({
  slidesControls: {
    display: "flex",
    flexShrink: "0",
    flexDirection: "column",
    gap: "0.5rem",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingBlock: "0.5rem",
    paddingInline: "0.75rem",
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
  },
  at: {
    minWidth: "3.5rem",
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  title: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  strip: {
    display: "flex",
    gap: "0.5rem",
    overflowX: "auto",
    paddingBottom: "0.25rem",
  },
  thumb: {
    position: "relative",
    flexShrink: "0",
    width: `${thumbWidth}px`,
    height: `${thumbHeight}px`,
    overflow: "hidden",
    padding: "0",
    cursor: "pointer",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-line)",
      ":hover": "var(--color-faint)",
    },
    backgroundColor: "var(--color-side)",
  },
  thumbOn: {
    outlineStyle: "solid",
    outlineWidth: "2px",
    outlineColor: "var(--color-accent)",
    outlineOffset: "1px",
  },
  thumbFrame: {
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    borderWidth: "0",
  },
  thumbNumber: {
    position: "absolute",
    top: "0.25rem",
    right: "0.25rem",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-page)",
    paddingInline: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
});

/** A deck's controls: step, the slide's title, thumbnails, the whole screen, the speaker's window and the PDF. The speaker's
 * window and this one follow each other. */
export function SlidesControls(props: Controls) {
  const pages = () => props.shown().ready?.pages ?? 0;
  const at = () => props.shown().at?.page ?? 0;
  const slideNumbers = (): readonly number[] => Arr.makeBy(pages(), (i: number) => i);
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
      <div data-testid="slides-controls" data-at={at()} data-pages={pages()} {...stylex.attrs(viewStyles.slidesControls)}>
        <div {...stylex.attrs(viewStyles.bar)}>
          <IconButton
            icon="previous"
            label={t("web.artifact.slides.previous")}
            testid="slides-previous"
            disabled={at() === 0}
            onClick={() => goto(stepped({ at: at(), step: -1, pages: pages() }))}
          />
          <span data-testid="slides-at" {...stylex.attrs(viewStyles.at)}>
            {t("web.artifact.slides.at", { at: at() + 1, pages: pages() })}
          </span>
          <IconButton
            icon="next"
            label={t("web.artifact.slides.next")}
            testid="slides-next"
            disabled={at() >= pages() - 1}
            onClick={() => goto(stepped({ at: at(), step: 1, pages: pages() }))}
          />
          <span {...stylex.attrs(viewStyles.title)}>{props.shown().ready?.titles?.[at()] ?? ""}</span>
          <IconButton icon="present" label={t("web.artifact.slides.present")} testid="slides-present" onClick={present} />
          <IconButton icon="presenter" label={t("web.artifact.slides.presenter")} testid="slides-presenter" onClick={speaker} />
          <IconButton icon="pdf" label={t("web.artifact.slides.pdf")} testid="slides-pdf" onClick={pdf} />
        </div>
        <Show when={pages() > 1}>
          <div role="group" aria-label={t("web.artifact.slides.thumbnails")} data-testid="slides-strip" {...stylex.attrs(viewStyles.strip)}>
            <For each={slideNumbers()}>
              {(i: number) => (
                <button
                  type="button"
                  data-testid="slides-thumb"
                  data-page={i}
                  aria-current={i === at() ? "true" : undefined}
                  aria-label={t("web.artifact.slides.slide", { at: i + 1, title: props.shown().ready?.titles?.[i] ?? "" })}
                  {...stylex.attrs(viewStyles.thumb, i === at() && viewStyles.thumbOn)}
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
                    {...stylex.attrs(viewStyles.thumbFrame)}
                  />
                  <span {...stylex.attrs(viewStyles.thumbNumber)}>{i + 1}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
