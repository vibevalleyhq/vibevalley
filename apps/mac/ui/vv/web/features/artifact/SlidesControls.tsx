// Ported from VibeValley apps/web/src/features/artifact/SlidesControls.tsx:
// a deck's controls: step, the slide's title, thumbnails (each a still web
// view of its slide), showing it and the speaker's view. Present fills the
// view with the deck (there is no fullscreen element); the speaker's view
// is /present in this same view (no popup window), so the BroadcastChannel
// that keeps two windows on one slide is not needed. Not ported: the PDF
// (the shell's ?print=1 opens a print dialog no web view here has).
import { Scroll, Text, View, WebView } from "nsh";

import { t } from "@vibevalley/i18n";

import { useRouter } from "../../infra/router";
import { shownTheme } from "../../state/prefs";
import { IconButton } from "../../ui/IconButton";
import { withShellQuery } from "./frame";
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
      <View testID="slides-controls" accessibilityValue={{ now: at(), max: pages() }} class="shrink-0 gap-2 border-t border-line px-3 py-2">
        <View class="flex-row items-center gap-1">
          <IconButton
            icon="previous"
            label={t("web.artifact.slides.previous")}
            testid="slides-previous"
            disabled={at() === 0}
            onClick={() => goto(stepped({ at: at(), step: -1, pages: pages() }))}
          />
          <View class="min-w-14 items-center">
            <Text testID="slides-at" class="text-xs text-muted tabular-nums">
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
          <Text class="min-w-0 flex-1 truncate text-xs text-faint">{title(at())}</Text>
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
              {(i) => (
                <View
                  role="button"
                  testID="slides-thumb"
                  accessibilityLabel={t("web.artifact.slides.slide", { at: i() + 1, title: title(i()) })}
                  accessibilityState={{ selected: i() === at() }}
                  onPress={() => goto(i())}
                  class={`h-18 w-32 shrink-0 overflow-hidden rounded-md border bg-side ${i() === at() ? "border-accent" : "border-line hover:border-faint"}`}
                  style={i() === at() ? { borderWidth: 2 } : undefined}
                >
                  <Slide id={props.artifact.id} version={props.version} at={i()} onPress={() => goto(i())} />
                  <View class="absolute top-1 right-1 rounded-sm bg-page px-1">
                    <Text class="text-xs text-muted">{String(i() + 1)}</Text>
                  </View>
                </View>
              )}
            </Each>
          </Scroll>
        </If>
      </View>
    </If>
  );
}

/** One slide, still: no keys or clicks of its own. A web view takes the pointer over its box, so a press inside it is
 * told out (`picked`) and given to `onPress`. */
const picked = String.raw`addEventListener("click", (e) => { e.preventDefault(); try { window.nsh.postMessage("pick"); } catch {} }, true);`;

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
            injectedJavaScriptBeforeContentLoaded={picked}
            onMessage={(e) => e.data === "pick" && props.onPress?.()}
            accessibilityElementsHidden
            class="h-full w-full"
          />
        )}
      </If>
    </View>
  );
}
