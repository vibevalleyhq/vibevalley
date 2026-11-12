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

/** The speaker's window of a deck: this slide, the next, its notes and the time. It and the workbench's tab follow each other. */
export function PresenterPage() {
  const router = useRouter();
  const asked = () => presenterOf(new URL(router.path(), window.location.origin).search);
  return (
    <Show when={asked()} fallback={<p class="p-6 text-muted">{t("web.artifact.presenter.missing")}</p>}>
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
    <main
      data-testid="presenter"
      data-at={at()}
      data-pages={pages()}
      class="grid h-screen grid-cols-[1fr] md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 p-4 bg-side text-ink"
    >
      <section aria-label={t("web.artifact.presenter.current")} class="flex min-h-0 flex-col gap-3">
        <iframe
          ref={setFrame}
          data-testid="presenter-current"
          title={t("web.artifact.presenter.current")}
          src={shellPath(props.id, props.version, "slides", shownTheme())}
          sandbox={htmlSandbox}
          referrerpolicy="no-referrer"
          class="w-full aspect-video rounded-lg border border-line bg-page"
        />
        <div class="flex items-center gap-2">
          <IconButton
            icon="previous"
            label={t("web.artifact.slides.previous")}
            testid="presenter-previous"
            disabled={at() === 0}
            onClick={() => goto(stepped({ at: at(), step: -1, pages: pages() }))}
          />
          <span data-testid="presenter-at" class="tabular-nums text-sm text-muted">
            {t("web.artifact.slides.at", { at: at() + 1, pages: pages() })}
          </span>
          <IconButton
            icon="next"
            label={t("web.artifact.slides.next")}
            testid="presenter-next"
            disabled={at() >= pages() - 1}
            onClick={() => goto(stepped({ at: at(), step: 1, pages: pages() }))}
          />
          <span data-testid="presenter-clock" aria-label={t("web.artifact.presenter.clock")} class="ml-auto tabular-nums text-xl font-semibold">
            {elapsedText(now() - started())}
          </span>
          <Button onClick={() => setStarted(now())}>{t("web.artifact.presenter.restart")}</Button>
        </div>
      </section>
      <aside aria-label={t("web.artifact.presenter.aside")} class="flex min-h-0 flex-col gap-3">
        <span class="text-xs text-faint">{t("web.artifact.presenter.next")}</span>
        <Show
          when={pages() > 0 && at() < pages() - 1}
          fallback={
            <div class="flex w-full aspect-video items-center justify-center rounded-md border-dashed border border-line text-faint">
              {t("web.artifact.presenter.end")}
            </div>
          }
        >
          <iframe
            data-testid="presenter-next-slide"
            title={t("web.artifact.presenter.next")}
            tabindex={-1}
            src={shellPath(props.id, props.version, "slides", shownTheme(), { at: at() + 1, still: true })}
            sandbox={htmlSandbox}
            referrerpolicy="no-referrer"
            class="w-full aspect-video pointer-events-none rounded-md border border-line bg-page"
          />
        </Show>
        <span class="text-xs text-faint">{t("web.artifact.presenter.notes")}</span>
        <div data-testid="presenter-notes" class="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-lg leading-[1.6]">
          {notes() || t("web.artifact.presenter.noNotes")}
        </div>
        <span class="text-xs text-faint">{title()}</span>
      </aside>
    </main>
  );
}
