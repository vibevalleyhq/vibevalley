import { Scroll, Text, View, WebView } from "nsh";

import { t } from "@vibevalley/i18n";

import { IconButton } from "../../design/IconButton";
import { useRouter } from "../../infra/router";
import { shownTheme } from "../../infra/state/prefs";
import { pickShim, withShellQuery } from "./frame";
import type { Controls } from "./HtmlFrame";
import { presenterHref, stepped } from "./slides";
import { useArtifactPage } from "./store";

export function SlidesControls(props: Controls) {
  const router = useRouter();
  const pages = () => props.frame.shown().ready?.pages ?? 0;
  const at = () => props.frame.shown().at?.page ?? 0;
  const slideNumbers = (): readonly number[] => Array.from({ length: pages() }, (_, i) => i);
  const goto = (page: number) => props.frame.send({ vibevalley: "goto", page });
  const title = (i: number) => props.frame.shown().ready?.titles?.[i] ?? "";
  return (
    <If when={pages() > 0}>
      <View testID="slides-controls" accessibilityValue={{ now: at(), max: pages() }} class="shrink-0 gap-2 border-t border-line bg-page px-3 py-2">
        <View class="h-7 flex-row items-center gap-1.5">
          <IconButton
            icon="previous"
            label={t("web.artifact.slides.previous")}
            testid="slides-previous"
            disabled={at() === 0}
            onClick={() => goto(stepped({ at: at(), step: -1, pages: pages() }))}
          />
          <View class="min-w-14 items-center">
            <Text testID="slides-at" class="text-xs font-medium text-muted tabular-nums">
              {t("web.artifact.slides.at", { at: at() + 1, pages: pages() })}
            </Text>
          </View>
          <IconButton
            icon="next"
            label={t("web.artifact.slides.next")}
            testid="slides-next"
            disabled={at() >= pages() - 1}
            onClick={() => goto(stepped({ at: at(), step: 1, pages: pages() }))}
          />
          <Text class="min-w-0 flex-1 truncate px-1 text-xs text-muted">{title(at())}</Text>
          <View class="mx-0.5 h-4 w-px bg-line" />
          <IconButton icon="present" label={t("web.artifact.slides.present")} testid="slides-present" onClick={() => props.onPresent(true)} />
          <IconButton
            icon="presenter"
            label={t("web.artifact.slides.presenter")}
            testid="slides-presenter"
            onClick={() => router.navigate(presenterHref({ id: props.artifact.id, version: props.version }))}
          />
        </View>
        <If when={pages() > 1}>
          <Scroll horizontal accessibilityLabel={t("web.artifact.slides.thumbnails")} testID="slides-strip" contentClass="flex-row gap-2 pb-1">
            <Each of={slideNumbers()}>
              {(i) => {
                const selected = () => i() === at();
                return (
                  <View
                    role="button"
                    testID="slides-thumb"
                    accessibilityLabel={t("web.artifact.slides.slide", { at: i() + 1, title: title(i()) })}
                    accessibilityState={{ selected: selected() }}
                    onPress={() => goto(i())}
                    class={`relative h-18 w-32 shrink-0 overflow-hidden rounded-md border bg-side focus-visible:outline-2 focus-visible:outline-focus ${
                      selected() ? "border-accent shadow-raise" : "border-line hover:border-faint"
                    }`}
                  >
                    <Slide id={props.artifact.id} version={props.version} at={i()} onPress={() => goto(i())} />
                    <If when={selected()}>
                      <View class="pointer-events-none absolute inset-0 rounded-sm border border-accent" />
                    </If>
                    <View class={`absolute top-1 right-1 rounded-xs border px-1.5 py-px ${selected() ? "border-accent bg-accent" : "border-line bg-page"}`}>
                      <Text class={`font-mono text-2xs font-medium tabular-nums ${selected() ? "text-page" : "text-muted"}`}>{String(i() + 1)}</Text>
                    </View>
                  </View>
                );
              }}
            </Each>
          </Scroll>
        </If>
      </View>
    </If>
  );
}

export function Slide(props: { id: string; version: number; at: number; class?: string; onPress?: () => void }) {
  const page = useArtifactPage(() => ({ id: props.id, version: props.version, theme: shownTheme() }));
  return (
    <View class={`h-full w-full ${props.class ?? ""}`}>
      <If when={page.html()}>
        {(html) => (
          <WebView
            html={withShellQuery(html(), { at: props.at, still: true })}
            incognito
            scrollable={false}
            injectedJavaScriptBeforeContentLoaded={pickShim}
            onMessage={(e) => e.data === "pick" && props.onPress?.()}
            accessibilityElementsHidden
            class="h-full w-full"
          />
        )}
      </If>
    </View>
  );
}
