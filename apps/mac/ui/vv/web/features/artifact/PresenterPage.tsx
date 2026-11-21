import { cleanup, keymap, Scroll, signal, Text, View, WebView } from "nsh";

import { t } from "@vibevalley/i18n";
import { artifactId } from "@vibevalley/protocol/schema";

import { useNow } from "../../base/dom";
import { reasonOf } from "../../infra/api";
import { useRouter } from "../../infra/router";
import { shownTheme } from "../../state/prefs";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Empty, Kbd } from "../../ui/layout";
import { artifactHref, useArtifact } from "./ArtifactCard";
import { createFrame, shim, withShellQuery } from "./frame";
import { elapsedText, presenterOf, stepped } from "./slides";
import { Slide } from "./SlidesControls";
import { useArtifactPage, useStoreViewHtml } from "./store";

function withSlideQuery(html: string, at: number, still: boolean): string {
  const asked = new URLSearchParams();
  asked.set("at", String(at));
  if (still) asked.set("still", "1");
  const read = "new URLSearchParams(location.search)";
  const idx = html.lastIndexOf(read);
  return idx < 0 ? html : `${html.slice(0, idx)}new URLSearchParams(${JSON.stringify(asked.toString())})${html.slice(idx + read.length)}`;
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
  const isStore = () => artifact.data()?.body === "store";
  const htmlPage = useArtifactPage(() => (isStore() ? undefined : { id: props.id, version: props.version, theme: shownTheme() }));
  const storeView = useStoreViewHtml(() => (isStore() ? { id: artifactId(props.id), theme: shownTheme(), seq: props.version } : undefined));
  const currentHtml = () => {
    if (isStore()) return storeView.html();
    const raw = htmlPage.html();
    return raw !== undefined ? withShellQuery(raw) : undefined;
  };
  const frame = createFrame();
  const pages = () => frame.shown().ready?.pages ?? 0;
  const statusText = () => {
    const state = frame.state();
    const error = isStore() ? storeView.error() : htmlPage.error();
    if (error) return t("web.artifact.presenter.loadFailure", { reason: typeof error === "string" ? error : reasonOf(error) });
    if (typeof state === "object") return t("web.artifact.presenter.loadFailure", { reason: state.error });
    return frame.shown().ready ? t("web.artifact.presenter.empty") : t("web.artifact.presenter.waiting");
  };
  const at = () => frame.shown().at?.page ?? 0;
  const goto = (page: number) => frame.send({ vibevalley: "goto", page });
  const goBack = () => router.navigate(artifactHref(props.id, isStore() ? undefined : props.version));
  const now = useNow(1000);
  const started = signal(now());
  const step = (n: 1 | -1) => {
    if (pages() > 0) goto(stepped({ at: at(), step: n, pages: pages() }));
  };
  cleanup(
    keymap.bind(
      { right: () => step(1), pagedown: () => step(1), space: () => step(1), left: () => step(-1), pageup: () => step(-1), escape: goBack },
      { when: "notEditing" },
    ),
  );
  const title = () => artifact.data()?.title ?? "";
  const notes = () => frame.shown().ready?.notes?.[at()] ?? "";
  return (
    <View testID="presenter" accessibilityValue={{ now: at(), max: pages() }} class="h-full min-h-0 flex-1 bg-side">
      <View class="h-12 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-4">
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
          <Text testID="presenter-clock" accessibilityLabel={t("web.artifact.presenter.clock")} class="font-mono text-base font-semibold text-ink tabular-nums">
            {elapsedText(now() - started())}
          </Text>
          <Button tone="quiet" icon="refresh" onPress={() => started.set(now())}>
            {t("web.artifact.presenter.restart")}
          </Button>
        </View>
      </View>

      <View class="min-h-0 flex-1 gap-4 p-4 md:flex-row">
        <View accessibilityLabel={t("web.artifact.presenter.current")} class="min-h-0 gap-3 md:flex-2">
          <View class="aspect-video w-full overflow-hidden rounded-lg border border-line bg-page shadow-raise">
            <If when={currentHtml()}>
              {(html) => (
                <WebView
                  ref={(r) => frame.setRef(r)}
                  testID="presenter-current"
                  accessibilityLabel={t("web.artifact.presenter.current")}
                  html={html()}
                  incognito
                  injectedJavaScriptBeforeContentLoaded={shim}
                  onLoad={() => frame.setState("loaded")}
                  onError={(e) => frame.setState({ error: e.code ?? e.message })}
                  onMessage={(e) => frame.heard(e.data)}
                  class="h-full w-full"
                />
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
              when={pages() > 0 && at() < pages() - 1}
              else={
                <View class="aspect-video w-full items-center justify-center rounded-lg border border-dashed border-line bg-page">
                  <If when={pages() > 0}>
                    <Text class="text-xs text-faint">{t("web.artifact.presenter.end")}</Text>
                  </If>
                </View>
              }
            >
              <View testID="presenter-next-slide" class="aspect-video w-full overflow-hidden rounded-lg border border-line bg-page shadow-raise">
                <If when={isStore()} else={<Slide id={props.id} version={props.version} at={at() + 1} />}>
                  <If when={storeView.html()}>
                    {(html) => (
                      <WebView html={withSlideQuery(html(), at() + 1, true)} incognito scrollable={false} accessibilityElementsHidden class="h-full w-full" />
                    )}
                  </If>
                </If>
              </View>
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
