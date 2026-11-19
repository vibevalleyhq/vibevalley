// Ported from VibeValley apps/web/src/features/artifact/PresenterPage.tsx:
// the speaker's view of a deck (both html and store-backed slides): this slide,
// the next, its notes and the time. VibeValley opens it as a popup window that
// follows the workbench's tab over a BroadcastChannel; here it is a page of the
// same view (with a way back to the deck), so no BroadcastChannel is needed.
import { cleanup, keymap, Scroll, signal, Text, View, WebView } from "nsh";

import { t } from "@vibevalley/i18n";
import { artifactId } from "@vibevalley/protocol/schema";

import { useNow } from "../../base/dom";
import { reasonOf } from "../../infra/api";
import { useRouter } from "../../infra/router";
import { shownTheme } from "../../state/prefs";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
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
        <View class="p-6">
          <Text class="text-muted">{t("web.artifact.presenter.missing")}</Text>
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
  const now = useNow(1000);
  const started = signal(now());
  const step = (n: 1 | -1) => {
    if (pages() > 0) goto(stepped({ at: at(), step: n, pages: pages() }));
  };
  cleanup(
    keymap.bind({ right: () => step(1), pagedown: () => step(1), space: () => step(1), left: () => step(-1), pageup: () => step(-1) }, { when: "notEditing" }),
  );
  const title = () => artifact.data()?.title ?? "";
  const notes = () => frame.shown().ready?.notes?.[at()] ?? "";
  return (
    <View testID="presenter" accessibilityValue={{ now: at(), max: pages() }} class="h-full flex-1 gap-4 bg-side p-4 md:flex-row">
      <View accessibilityLabel={t("web.artifact.presenter.current")} class="min-h-0 gap-3 md:flex-2">
        <View class="aspect-video w-full overflow-hidden rounded-lg border border-line bg-page">
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
        <View class="flex-row items-center gap-2">
          <IconButton
            icon="back"
            label={t("web.artifact.page.all")}
            testid="presenter-back"
            onClick={() => router.navigate(artifactHref(props.id, isStore() ? undefined : props.version))}
          />
          <IconButton icon="previous" label={t("web.artifact.slides.previous")} testid="presenter-previous" disabled={at() === 0} onClick={() => step(-1)} />
          <If
            when={pages() > 0}
            else={
              <Text testID="presenter-status" class="text-sm text-muted">
                {statusText()}
              </Text>
            }
          >
            <Text testID="presenter-at" class="text-sm text-ink">{`${at() + 1} / ${pages()}`}</Text>
          </If>
          <IconButton icon="next" label={t("web.artifact.slides.next")} testid="presenter-next" disabled={at() >= pages() - 1} onClick={() => step(1)} />
          <View class="flex-1" />
          <Text testID="presenter-clock" accessibilityLabel={t("web.artifact.presenter.clock")} class="text-xl font-semibold text-ink tabular-nums">
            {elapsedText(now() - started())}
          </Text>
          <Button onPress={() => started.set(now())}>{t("web.artifact.presenter.restart")}</Button>
        </View>
      </View>
      <View accessibilityLabel={t("web.artifact.presenter.aside")} class="min-h-0 gap-3 md:flex-1">
        <Text class="text-xs text-faint">{t("web.artifact.presenter.next")}</Text>
        <If
          when={pages() > 0 && at() < pages() - 1}
          else={
            <View class="aspect-video w-full items-center justify-center rounded-md border border-dashed border-line">
              <If when={pages() > 0}>
                <Text class="text-faint">{t("web.artifact.presenter.end")}</Text>
              </If>
            </View>
          }
        >
          <View testID="presenter-next-slide" class="aspect-video w-full overflow-hidden rounded-md border border-line bg-page">
            <If when={isStore()} else={<Slide id={props.id} version={props.version} at={at() + 1} />}>
              <If when={storeView.html()}>
                {(html) => (
                  <WebView html={withSlideQuery(html(), at() + 1, true)} incognito scrollable={false} accessibilityElementsHidden class="h-full w-full" />
                )}
              </If>
            </If>
          </View>
        </If>
        <Text class="text-xs text-faint">{t("web.artifact.presenter.notes")}</Text>
        <Scroll class="min-h-0 flex-1">
          <Text testID="presenter-notes" class="text-lg text-ink" style={{ lineHeight: 28.8 }}>
            {pages() > 0 ? notes() || t("web.artifact.presenter.noNotes") : ""}
          </Text>
        </Scroll>
        <Text class="text-xs text-faint">{title()}</Text>
      </View>
    </View>
  );
}
