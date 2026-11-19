import { Scroll, Text, View, WebView } from "nsh";
import { z } from "zod";

import { htmlEdit } from "@vibevalley/artifact/html";
import { t } from "@vibevalley/i18n";
import type { HtmlAnchor } from "@vibevalley/protocol";

import { createEffect, createMemo, createSignal } from "../../../solid";
import { useRouter } from "../../infra/router";
import { shownTheme } from "../../state/prefs";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { TextArea } from "../../ui/Field";
import { IconButton } from "../../ui/IconButton";
import { toast } from "../../ui/toasts";
import type { Frame } from "./frame";
import { HtmlFrame } from "./HtmlFrame";
import { presenterHref } from "./slides";
import { useReportViewContext, useStoreEntries, useStoreViewHtml } from "./store";
import type { StoreViewerProps } from "./StoreArtifactView";

const DeckSlideSchema = z.object({
  id: z.string(),
  file: z.exactOptional(z.string()),
  title: z.exactOptional(z.string()),
  notes: z.exactOptional(z.string()),
  skip: z.exactOptional(z.boolean()),
});

const DeckJsonSchema = z.object({
  title: z.exactOptional(z.string()),
  aspectRatio: z.exactOptional(z.enum(["16:9", "4:3"])),
  slides: z.exactOptional(z.array(DeckSlideSchema)),
});

interface SlideSummary {
  readonly id: string;
  readonly file?: string | undefined;
  readonly title?: string | undefined;
  readonly notes?: string | undefined;
}

const pickedThumb = String.raw`addEventListener("click", (e) => { e.preventDefault(); try { window.nsh.postMessage("pick"); } catch {} }, true);`;

function withStillAt(html: string, at: number): string {
  const read = "new URLSearchParams(location.search)";
  const pos = html.lastIndexOf(read);
  if (pos < 0) return html;
  const qs = `at=${at}&still=1`;
  return `${html.slice(0, pos)}new URLSearchParams(${JSON.stringify(qs)})${html.slice(pos + read.length)}`;
}

export function SlidesStoreView(props: StoreViewerProps) {
  const router = useRouter();
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const [frame, setFrame] = createSignal<Frame>();
  const act = createAct();

  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.artifact.seq);

  const deck = createMemo(() => {
    const raw = snapshot().entries.get("project/deck.json")?.value;
    if (!raw) return undefined;
    try {
      const parsed = DeckJsonSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch (e) {
      if (e instanceof SyntaxError) return undefined;
      throw e;
    }
  });

  const slideList = createMemo((): readonly SlideSummary[] => {
    const d = deck();
    if (d?.slides && d.slides.length > 0) return d.slides.filter((s) => s.skip !== true);
    return [...snapshot().entries.keys()]
      .filter((p) => p.startsWith("project/slides/") && p.endsWith(".html"))
      .toSorted()
      .map((p) => ({
        id: p.slice("project/slides/".length, -".html".length),
        file: p.slice("project/slides/".length),
      }));
  });

  const aspect = () => deck()?.aspectRatio ?? "16:9";
  const shown = () => frame()?.shown();
  const pages = () => shown()?.ready?.pages ?? slideList().length;
  const at = () => shown()?.at?.page ?? 0;
  const frag = () => shown()?.at?.fragment ?? 0;
  const maxFrag = () => shown()?.ready?.fragments?.[at()] ?? 0;
  const currentSlide = () => slideList()[at()];
  const currentSlidePath = () => {
    const cur = currentSlide();
    if (!cur) return "project/slides/s01.html";
    const rel = cur.file ?? `${cur.id}.html`;
    return rel.startsWith("project/") ? rel : `project/slides/${rel}`;
  };
  const currentNotes = () => {
    const fromRuntime = shown()?.ready?.notes?.[at()];
    return fromRuntime && fromRuntime.trim() !== "" ? fromRuntime : (currentSlide()?.notes ?? "");
  };

  useReportViewContext(
    () => props.artifact.id,
    () => {
      const cur = currentSlide();
      return {
        artifactType: "slides",
        title: props.artifact.title,
        seq: seq(),
        slideIndex: at(),
        ...(cur?.id ? { slideId: cur.id } : {}),
      };
    },
  );

  const goto = (page: number) => frame()?.send({ vibevalley: "goto", page });
  const step = (delta: -1 | 1) => frame()?.send({ vibevalley: "step", delta });

  const [picked, setPicked] = createSignal<{ readonly anchor: HtmlAnchor; readonly path: string }>();
  const [pickedText, setPickedText] = createSignal("");
  createEffect(
    () => frame()?.picked(),
    (sel) => {
      if (!sel) return;
      setPicked({ anchor: sel, path: sel.path ?? currentSlidePath() });
      setPickedText(sel.exact.trim());
    },
  );

  const savePickedWords = () => {
    const sel = picked();
    if (!sel || act.busy()) return;
    const entry = snapshot().entries.get(sel.path);
    if (!entry?.value) return;
    const edited = htmlEdit(entry.value, sel.anchor, pickedText());
    if (!edited.ok) {
      toast(edited.why, "bad");
      return;
    }
    void act.run(async () => {
      await client.batch([{ op: "set", path: sel.path, kind: "text", value: edited.source }]);
      setPicked(undefined);
      toast(t("web.artifact.slidesStore.savedSlide"));
    });
  };

  const [showNotes, setShowNotes] = createSignal(false);
  const [editingHtml, setEditingHtml] = createSignal(false);
  const [htmlDraft, setHtmlDraft] = createSignal("");
  const toggleEditHtml = () => {
    if (!editingHtml()) {
      setHtmlDraft(snapshot().entries.get(currentSlidePath())?.value ?? "");
      setEditingHtml(true);
    } else {
      setEditingHtml(false);
    }
  };
  const saveSlideHtml = () => {
    const path = currentSlidePath();
    const val = htmlDraft();
    void act.run(async () => {
      await client.batch([{ op: "set", path, kind: "text", value: val }]);
      setEditingHtml(false);
      toast(t("web.artifact.slidesStore.savedSlide"));
    });
  };

  const toggleAspect = () => {
    const nextAspect = aspect() === "16:9" ? "4:3" : "16:9";
    void act.run(async () => {
      await client.batch([{ op: "patch", path: "project/deck.json", value: JSON.stringify({ aspectRatio: nextAspect }) }]);
    });
  };

  const addSlide = () => {
    const existing = slideList();
    const nextNum = existing.length + 1;
    const nextId = `s${String(nextNum).padStart(2, "0")}`;
    const file = `${nextId}.html`;
    const nextSlides = [...(deck()?.slides ?? existing), { id: nextId, file, title: `Slide ${nextNum}` }];
    void act.run(async () => {
      await client.batch([
        {
          op: "set",
          path: `project/slides/${file}`,
          kind: "text",
          value: `<section class="slide"><h2>Slide ${nextNum}</h2><p>Key takeaway goes here.</p></section>`,
        },
        {
          op: "patch",
          path: "project/deck.json",
          value: JSON.stringify({ slides: nextSlides }),
        },
      ]);
    });
  };

  const thumbView = useStoreViewHtml(() => (pages() > 1 ? { id: props.artifact.id, theme: shownTheme(), seq: seq() } : undefined));
  const slideNumbers = (): readonly number[] => Array.from({ length: pages() }, (_, i) => i);
  const slideTitle = (i: number) => shown()?.ready?.titles?.[i] ?? slideList()[i]?.title ?? "";

  return (
    <View testID="slides-store-view" class="min-h-0 min-w-0 flex-1">
      <If when={snapshot().error}>
        {(err) => (
          <View class="px-3 py-2">
            <Text class="text-xs text-berry">{err()}</Text>
          </View>
        )}
      </If>

      <HtmlFrame
        artifact={props.artifact}
        version={seq()}
        viewSeq={seq()}
        title={props.artifact.title}
        testId="slides-store-frame"
        frameClass={props.frameClass ?? "min-h-0 w-full flex-1 bg-side"}
        hideControls
        covered={props.covered}
        onFrame={(f) => setFrame(f)}
        onPresent={props.onPresent}
      />

      <View
        testID="slides-store-controls"
        accessibilityValue={{ now: at(), max: Math.max(1, pages()) }}
        class="shrink-0 gap-2 border-t border-line bg-page px-3 py-2"
      >
        <View class="flex-row flex-wrap items-center gap-1.5">
          <IconButton
            icon="previous"
            label={t("web.artifact.slides.previous")}
            testid="slides-previous"
            disabled={at() === 0 && frag() === 0}
            onClick={() => step(-1)}
          />
          <View class="min-w-16 items-center">
            <Text testID="slides-at" class="text-xs text-muted tabular-nums">
              {maxFrag() > 0
                ? t("web.artifact.slidesStore.stepAt", { at: at() + 1, pages: Math.max(1, pages()), frag: frag(), frags: maxFrag() })
                : t("web.artifact.slides.at", { at: at() + 1, pages: Math.max(1, pages()) })}
            </Text>
          </View>
          <IconButton
            icon="next"
            label={t("web.artifact.slides.next")}
            testid="slides-next"
            disabled={at() >= pages() - 1 && frag() >= maxFrag()}
            onClick={() => step(1)}
          />
          <Text class="min-w-0 flex-1 truncate text-xs text-faint">{slideTitle(at())}</Text>
          <Button testID="slides-aspect" disabled={act.busy()} onPress={toggleAspect}>
            {aspect() === "4:3" ? t("web.artifact.slidesStore.aspect4x3") : t("web.artifact.slidesStore.aspect16x9")}
          </Button>
          <Button icon="add" testID="slides-add" disabled={act.busy()} onPress={addSlide}>
            {t("web.artifact.slidesStore.addSlide")}
          </Button>
          <IconButton
            icon="notes"
            label={t("web.artifact.presenter.notes")}
            testid="slides-notes-toggle"
            pressed={showNotes()}
            onClick={() => setShowNotes((v) => !v)}
          />
          <IconButton icon="edit" label={t("web.artifact.slidesStore.editSlide")} testid="slides-edit-html" pressed={editingHtml()} onClick={toggleEditHtml} />
          <IconButton icon="present" label={t("web.artifact.slides.present")} testid="slides-present" onClick={() => props.onPresent?.(true)} />
          <IconButton
            icon="presenter"
            label={t("web.artifact.slides.presenter")}
            testid="slides-presenter"
            onClick={() => router.navigate(presenterHref({ id: props.artifact.id, version: seq() }))}
          />
        </View>

        <If when={showNotes()}>
          <View testID="slides-notes-panel" class="gap-1 rounded-md border border-line bg-side px-3 py-2">
            <Text class="text-xs font-medium text-muted">{t("web.artifact.presenter.notes")}</Text>
            <Text class={`text-xs ${currentNotes() ? "text-ink" : "text-faint"}`}>{currentNotes() || t("web.artifact.presenter.noNotes")}</Text>
          </View>
        </If>

        <If when={picked()}>
          {(sel) => (
            <View testID="slides-inline-edit" class="gap-1.5 rounded-md border border-line bg-side p-2.5">
              <View class="border-l-2 border-wheat pl-2">
                <Text class="text-xs text-muted" style={{ numberOfLines: 2 }}>
                  {sel().anchor.exact.trim()}
                </Text>
              </View>
              <TextArea rows={2} value={pickedText()} onInput={(val) => setPickedText(val)} />
              <View class="flex-row justify-end gap-1.5">
                <Button onPress={() => setPicked(undefined)}>{t("web.base.form.never")}</Button>
                <Button tone="primary" disabled={act.busy()} onPress={savePickedWords}>
                  {t("web.artifact.slidesStore.saveSlide")}
                </Button>
              </View>
            </View>
          )}
        </If>

        <If when={editingHtml()}>
          <View testID="slides-html-drawer" class="gap-2 rounded-md border border-line bg-side p-2.5">
            <Text class="font-mono text-xs text-muted">{currentSlidePath()}</Text>
            <TextArea rows={6} value={htmlDraft()} onInput={(val) => setHtmlDraft(val)} class="font-mono text-xs" />
            <View class="flex-row justify-end gap-1.5">
              <Button onPress={() => setEditingHtml(false)}>{t("web.base.form.never")}</Button>
              <Button tone="primary" testID="slides-save-html" disabled={act.busy()} onPress={saveSlideHtml}>
                {t("web.artifact.slidesStore.saveSlide")}
              </Button>
            </View>
          </View>
        </If>

        <If when={pages() > 1}>
          <Scroll horizontal accessibilityLabel={t("web.artifact.slides.thumbnails")} testID="slides-strip" contentClass="flex-row gap-2 pb-1">
            <Each of={slideNumbers()}>
              {(i) => (
                <View
                  role="button"
                  testID="slides-thumb"
                  accessibilityLabel={t("web.artifact.slides.slide", { at: i() + 1, title: slideTitle(i()) })}
                  accessibilityState={{ selected: i() === at() }}
                  onPress={() => goto(i())}
                  class={`h-18 w-32 shrink-0 overflow-hidden rounded-md border bg-side ${i() === at() ? "border-accent" : "border-line hover:border-faint"}`}
                  style={i() === at() ? { borderWidth: 2 } : undefined}
                >
                  <If when={thumbView.html()}>
                    {(html) => (
                      <WebView
                        html={withStillAt(html(), i())}
                        incognito
                        scrollable={false}
                        injectedJavaScriptBeforeContentLoaded={pickedThumb}
                        onMessage={(e) => e.data === "pick" && goto(i())}
                        accessibilityElementsHidden
                        class="h-full w-full"
                        style={props.covered === true ? { opacity: 0 } : undefined}
                      />
                    )}
                  </If>
                  <View class="absolute top-1 right-1 rounded-sm bg-page px-1">
                    <Text class="text-xs text-muted tabular-nums">{String(i() + 1)}</Text>
                  </View>
                </View>
              )}
            </Each>
          </Scroll>
        </If>
      </View>
    </View>
  );
}
