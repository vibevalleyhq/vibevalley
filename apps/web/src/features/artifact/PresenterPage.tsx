import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { useNow } from "#/base/dom.tsx";
import { useRouter } from "#/infra/router.ts";
import { shownTheme } from "#/state/prefs.ts";
import { Button } from "#/ui/Button.tsx";
import { IconButton } from "#/ui/IconButton.tsx";

import { useArtifact } from "./ArtifactCard";
import { sendTo, useShown } from "./frame";
import { shellPath } from "./shell";
import { elapsedText, presenterOf, slidePostOf, slidesChannelName, stepped } from "./slides";

const viewStyles = stylex.create({
  page: {
    display: "grid",
    height: "100vh",
    gridTemplateColumns: {
      default: "1fr",
      "@media (width>=48rem)": "minmax(0, 2fr) minmax(0, 1fr)",
    },
    gap: "calc(var(--spacing) * 4)",
    padding: "calc(var(--spacing) * 4)",
    backgroundColor: "var(--color-side)",
    color: "var(--color-ink)",
  },
  main: {
    display: "flex",
    minHeight: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  current: {
    width: "100%",
    aspectRatio: "16 / 9",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  at: {
    fontVariantNumeric: "tabular-nums",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  clock: {
    marginLeft: "auto",
    fontVariantNumeric: "tabular-nums",
    fontSize: "var(--text-xl)",
    lineHeight: "var(--text-xl--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  side: {
    display: "flex",
    minHeight: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  label: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-faint)",
  },
  next: {
    width: "100%",
    aspectRatio: "16 / 9",
    pointerEvents: "none",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
  },
  end: {
    display: "flex",
    width: "100%",
    aspectRatio: "16 / 9",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    borderStyle: "dashed",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    color: "var(--color-faint)",
  },
  notes: {
    minHeight: "0",
    flex: "1",
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    fontSize: "var(--text-lg)",
    lineHeight: "1.6",
  },
  missing: {
    padding: "calc(var(--spacing) * 6)",
    color: "var(--color-muted)",
  },
});

/** The speaker's window of a deck: this slide, the next, its notes and the time. It and the workbench's tab follow each other. */
export function PresenterPage() {
  const router = useRouter();
  const asked = () => presenterOf(new URL(router.path(), window.location.origin).search);
  return (
    <Show when={asked()} fallback={<p {...stylex.attrs(viewStyles.missing)}>{t("web.artifact.presenter.missing")}</p>}>
      {(a) => <Presenter id={a().id} version={a().version} />}
    </Show>
  );
}

function Presenter(props: { id: string; version: number }) {
  const artifact = useArtifact(() => props.id);
  const [frame, setFrame] = createSignal<HTMLIFrameElement>();
  const shown = useShown(frame);
  const pages = () => shown().ready?.pages ?? 0;
  const at = () => shown().at?.page ?? 0;
  const goto = (page: number) => sendTo(frame())({ vibevalley: "goto", page });
  const now = useNow(1000);
  const [started, setStarted] = createSignal(now());
  let channel: BroadcastChannel | undefined;
  onSettled(() => {
    channel = new BroadcastChannel(slidesChannelName(props));
    channel.onmessage = (e: MessageEvent) => {
      const page = slidePostOf(e.data);
      if (page !== undefined) goto(page);
    };
    const keys = (e: KeyboardEvent) => {
      const step = e.key === "ArrowRight" || e.key === "PageDown" || e.key === " " ? 1 : e.key === "ArrowLeft" || e.key === "PageUp" ? -1 : 0;
      if (step === 0 || pages() === 0) return;
      e.preventDefault();
      goto(stepped({ at: at(), step, pages: pages() }));
    };
    window.addEventListener("keydown", keys);
    return () => {
      channel?.close();
      window.removeEventListener("keydown", keys);
    };
  });
  createEffect(at, (page) => channel?.postMessage({ page }));
  const title = () => artifact.data()?.title ?? "";
  createEffect(title, (words) => {
    document.title = t("web.artifact.presenter.title", { title: words });
  });
  const notes = () => shown().ready?.notes?.[at()] ?? "";
  return (
    <main data-testid="presenter" data-at={at()} data-pages={pages()} {...stylex.attrs(viewStyles.page)}>
      <section aria-label={t("web.artifact.presenter.current")} {...stylex.attrs(viewStyles.main)}>
        <iframe
          ref={setFrame}
          data-testid="presenter-current"
          title={t("web.artifact.presenter.current")}
          src={shellPath(props.id, props.version, "slides", shownTheme())}
          sandbox={htmlSandbox}
          referrerpolicy="no-referrer"
          {...stylex.attrs(viewStyles.current)}
        />
        <div {...stylex.attrs(viewStyles.bar)}>
          <IconButton
            icon="previous"
            label={t("web.artifact.slides.previous")}
            testid="presenter-previous"
            disabled={at() === 0}
            onClick={() => goto(stepped({ at: at(), step: -1, pages: pages() }))}
          />
          <span data-testid="presenter-at" {...stylex.attrs(viewStyles.at)}>
            {t("web.artifact.slides.at", { at: at() + 1, pages: pages() })}
          </span>
          <IconButton
            icon="next"
            label={t("web.artifact.slides.next")}
            testid="presenter-next"
            disabled={at() >= pages() - 1}
            onClick={() => goto(stepped({ at: at(), step: 1, pages: pages() }))}
          />
          <span data-testid="presenter-clock" aria-label={t("web.artifact.presenter.clock")} {...stylex.attrs(viewStyles.clock)}>
            {elapsedText(now() - started())}
          </span>
          <Button onClick={() => setStarted(now())}>{t("web.artifact.presenter.restart")}</Button>
        </div>
      </section>
      <aside aria-label={t("web.artifact.presenter.aside")} {...stylex.attrs(viewStyles.side)}>
        <span {...stylex.attrs(viewStyles.label)}>{t("web.artifact.presenter.next")}</span>
        <Show when={pages() > 0 && at() < pages() - 1} fallback={<div {...stylex.attrs(viewStyles.end)}>{t("web.artifact.presenter.end")}</div>}>
          <iframe
            data-testid="presenter-next-slide"
            title={t("web.artifact.presenter.next")}
            tabindex={-1}
            src={shellPath(props.id, props.version, "slides", shownTheme(), { at: at() + 1, still: true })}
            sandbox={htmlSandbox}
            referrerpolicy="no-referrer"
            {...stylex.attrs(viewStyles.next)}
          />
        </Show>
        <span {...stylex.attrs(viewStyles.label)}>{t("web.artifact.presenter.notes")}</span>
        <div data-testid="presenter-notes" {...stylex.attrs(viewStyles.notes)}>
          {notes() || t("web.artifact.presenter.noNotes")}
        </div>
        <span {...stylex.attrs(viewStyles.label)}>{title()}</span>
      </aside>
    </main>
  );
}
