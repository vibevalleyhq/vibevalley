// Ported from VibeValley apps/web/src/features/artifact/PresenterPage.tsx:
// the speaker's view of a deck: this slide, the next, its notes and the
// time. VibeValley opens it as a popup window that follows the workbench's
// tab over a BroadcastChannel; here it is a page of the same view (with a
// way back to the deck), so there is nothing to follow. The arrow keys,
// PageUp/PageDown and Space step (keymap bindings while no field is being
// written in).
import { cleanup, keymap, Scroll, signal, Text, View, WebView } from "nsh";

import { t } from "@vibevalley/i18n";

import { useNow } from "../../base/dom";
import { useRouter } from "../../infra/router";
import { shownTheme } from "../../state/prefs";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { artifactHref, useArtifact, useArtifactContent } from "./ArtifactCard";
import { createFrame, framed, shim } from "./frame";
import { elapsedText, presenterOf, stepped } from "./slides";
import { Slide } from "./SlidesControls";

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
  const content = useArtifactContent(() => ({ id: props.id, version: props.version }));
  const frame = createFrame();
  const pages = () => frame.shown().ready?.pages ?? 0;
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
          <If when={content.data()}>
            {(c) => (
              <WebView
                ref={(r) => frame.setRef(r)}
                testID="presenter-current"
                accessibilityLabel={t("web.artifact.presenter.current")}
                html={framed({ page: c().content, display: "slides", theme: shownTheme() })}
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
            onClick={() => router.navigate(artifactHref(props.id, props.version))}
          />
          <IconButton icon="previous" label={t("web.artifact.slides.previous")} testid="presenter-previous" disabled={at() === 0} onClick={() => step(-1)} />
          <Text testID="presenter-at" class="text-sm text-muted tabular-nums">
            {t("web.artifact.slides.at", { at: at() + 1, pages: pages() })}
          </Text>
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
              <Text class="text-faint">{t("web.artifact.presenter.end")}</Text>
            </View>
          }
        >
          <View testID="presenter-next-slide" class="aspect-video w-full overflow-hidden rounded-md border border-line bg-page">
            <Slide id={props.id} version={props.version} at={at() + 1} />
          </View>
        </If>
        <Text class="text-xs text-faint">{t("web.artifact.presenter.notes")}</Text>
        <Scroll class="min-h-0 flex-1">
          <Text testID="presenter-notes" class="text-lg text-ink" style={{ lineHeight: 28.8 }}>
            {notes() || t("web.artifact.presenter.noNotes")}
          </Text>
        </Scroll>
        <Text class="text-xs text-faint">{title()}</Text>
      </View>
    </View>
  );
}
