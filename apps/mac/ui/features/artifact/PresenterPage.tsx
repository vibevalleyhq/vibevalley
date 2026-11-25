import { cleanup, computed, keymap, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { artifactId } from "@vibevalley/protocol/schema";

import { IconButton } from "../../design/IconButton";
import { Empty, Kbd } from "../../design/layout";
import { useNow } from "../../infra/base/dom";
import { useRouter } from "../../infra/router";
import { artifactHref, useArtifact } from "./ArtifactCard";
import { elapsedText, presenterOf, stepped } from "./slides";
import { useArtifactDirectory } from "./store";

interface SlideItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly notes: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function PresenterPage() {
  const router = useRouter();
  const asked = () => presenterOf(`?${router.path().split("?")[1] ?? ""}`);
  return (
    <If
      when={asked()}
      else={
        <View class="h-full flex-1 bg-page">
          <Empty icon="presenter">{t("web.artifact.presenter.missing")}</Empty>
        </View>
      }
    >
      {(a) => <Presenter id={a().id} version={a().version} />}
    </If>
  );
}

function Presenter(props: { id: string; version: number }) {
  const router = useRouter();
  const artifact = useArtifact(() => props.id);
  const { snapshot } = useArtifactDirectory(() => artifactId(props.id));
  const at = signal(0);

  const slides = computed((): readonly SlideItem[] => {
    const deck = parseJson(snapshot().contents.get("structure/deck.json")?.content);
    const list: unknown[] = Array.isArray(deck?.slides) ? deck.slides : [];
    return list.map((raw, idx) => {
      const rec = isRecord(raw) ? raw : {};
      const file = typeof rec.file === "string" ? rec.file : "";
      const detail = parseJson(file ? snapshot().contents.get(file)?.content : undefined);
      return {
        id: typeof rec.id === "string" ? rec.id : `slide-${idx + 1}`,
        title: typeof detail?.title === "string" ? detail.title : typeof rec.title === "string" ? rec.title : `Slide ${idx + 1}`,
        subtitle: typeof detail?.subtitle === "string" ? detail.subtitle : "",
        notes: typeof detail?.notes === "string" ? detail.notes : "",
      };
    });
  });

  const pages = () => slides().length;
  const current = () => slides()[at()];
  const nextSlide = () => slides()[at() + 1];
  const statusText = () => {
    const err = snapshot().error;
    if (err) return t("web.artifact.presenter.loadFailure", { reason: err });
    return snapshot().loading ? t("web.artifact.presenter.waiting") : t("web.artifact.presenter.empty");
  };
  const goBack = () => router.navigate(artifactHref(props.id));
  const now = useNow(1000);
  const started = signal(now());
  const step = (n: 1 | -1) => {
    if (pages() > 0) at.set(stepped({ at: at(), step: n, pages: pages() }));
  };
  cleanup(
    keymap.bind(
      { right: () => step(1), pagedown: () => step(1), space: () => step(1), left: () => step(-1), pageup: () => step(-1), escape: goBack },
      { when: "notEditing" },
    ),
  );
  const title = () => artifact.data()?.title ?? "";
  const notes = () => current()?.notes ?? "";

  return (
    <View testID="presenter" accessibilityValue={{ now: at(), max: pages() }} class="h-full min-h-0 flex-1 bg-side">
      <View class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3.5">
        <IconButton icon="back" label={t("web.artifact.page.all")} testid="presenter-back" onClick={goBack} />
        <View class="h-4 w-px bg-line" />
        <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title()}</Text>
        <View class="flex-row items-center gap-1.5">
          <IconButton icon="previous" label={t("web.artifact.slides.previous")} testid="presenter-previous" disabled={at() === 0} onClick={() => step(-1)} />
          <If
            when={pages() > 0}
            else={
              <Text testID="presenter-status" class="px-1 text-xs text-muted">
                {statusText()}
              </Text>
            }
          >
            <View class="min-w-14 items-center">
              <Text testID="presenter-at" class="font-mono text-sm font-semibold text-ink tabular-nums">{`${at() + 1} / ${pages()}`}</Text>
            </View>
          </If>
          <IconButton icon="next" label={t("web.artifact.slides.next")} testid="presenter-next" disabled={at() >= pages() - 1} onClick={() => step(1)} />
        </View>
        <View class="mx-1 h-4 w-px bg-line" />
        <View class="flex-row items-center gap-2">
          <Text testID="presenter-clock" accessibilityLabel={t("web.artifact.presenter.clock")} class="font-mono text-sm font-semibold text-ink tabular-nums">
            {elapsedText(now() - started())}
          </Text>
          <IconButton icon="refresh" label={t("web.artifact.presenter.restart")} testid="presenter-restart" onClick={() => started.set(now())} />
        </View>
      </View>

      <View class="min-h-0 flex-1 gap-4 p-4 md:flex-row">
        <View accessibilityLabel={t("web.artifact.presenter.current")} class="min-h-0 gap-3 md:flex-2">
          <View
            testID="presenter-current"
            class="aspect-video w-full justify-center gap-3 overflow-hidden rounded-lg border border-line bg-page p-8 shadow-raise"
          >
            <If when={current()}>
              {(slide) => (
                <>
                  <Text class="text-2xl font-semibold text-ink">{slide().title}</Text>
                  <If when={slide().subtitle}>
                    <Text class="text-base text-muted">{slide().subtitle}</Text>
                  </If>
                </>
              )}
            </If>
          </View>
          <View class="flex-row flex-wrap items-center justify-between gap-2 px-0.5">
            <View class="flex-row items-center gap-1.5">
              <Kbd size="md">←</Kbd>
              <Kbd size="md">→</Kbd>
              <Text class="text-xs text-faint">{t("web.base.shortcuts.say.flip")}</Text>
            </View>
            <View class="flex-row items-center gap-1.5">
              <Kbd size="md">Esc</Kbd>
              <Text class="text-xs text-faint">{t("web.artifact.page.all")}</Text>
            </View>
          </View>
        </View>

        <View accessibilityLabel={t("web.artifact.presenter.aside")} class="min-h-0 gap-3 md:flex-1">
          <View class="gap-1.5">
            <View class="flex-row items-center justify-between gap-2 px-0.5">
              <Text class="text-xs font-semibold text-muted">{t("web.artifact.presenter.next")}</Text>
              <If when={pages() > 0 && at() < pages() - 1}>
                <Text class="font-mono text-2xs text-faint tabular-nums">{`${at() + 2} / ${pages()}`}</Text>
              </If>
            </View>
            <If
              when={nextSlide()}
              else={
                <View class="aspect-video w-full items-center justify-center rounded-lg border border-dashed border-line bg-page">
                  <If when={pages() > 0}>
                    <Text class="text-xs text-faint">{t("web.artifact.presenter.end")}</Text>
                  </If>
                </View>
              }
            >
              {(slide) => (
                <View
                  testID="presenter-next-slide"
                  class="aspect-video w-full justify-center gap-1.5 overflow-hidden rounded-lg border border-line bg-page p-4 shadow-raise"
                >
                  <Text class="text-base font-semibold text-ink">{slide().title}</Text>
                  <If when={slide().subtitle}>
                    <Text class="text-xs text-muted">{slide().subtitle}</Text>
                  </If>
                </View>
              )}
            </If>
          </View>
          <View class="min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-page">
            <View class="shrink-0 border-b border-line px-3.5 py-2">
              <Text class="text-xs font-semibold text-muted">{t("web.artifact.presenter.notes")}</Text>
            </View>
            <Scroll class="min-h-0 flex-1" contentClass="p-3.5">
              <Text testID="presenter-notes" class={notes() ? "text-base leading-[26px] text-ink" : "text-sm text-faint"}>
                {pages() > 0 ? notes() || t("web.artifact.presenter.noNotes") : ""}
              </Text>
            </Scroll>
          </View>
        </View>
      </View>
    </View>
  );
}
