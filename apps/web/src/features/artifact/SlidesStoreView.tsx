import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { z } from "zod";

import { htmlEdit } from "@vibevalley/artifact/html";
import { shellMessageOf } from "@vibevalley/artifact/shell";
import { storeViewUrl } from "@vibevalley/artifact/viewers";
import { t } from "@vibevalley/i18n";
import type { Artifact, HtmlAnchor } from "@vibevalley/protocol";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { shownTheme } from "#/state/prefs.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { TextArea } from "#/ui/Field.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { toast } from "#/ui/toasts.ts";

import { sendTo, useShown } from "./frame";
import { presenterHref, slidePostOf, slidesChannelName } from "./slides";
import { useReportViewContext, useStoreEntries } from "./store";

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

export function SlidesStoreView(props: { artifact: Artifact; frameStyle?: JSX.ClassValue }) {
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const [frame, setFrame] = createSignal<HTMLIFrameElement>();
  const shown = useShown(frame);
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

  const slideList = createMemo((): readonly { id: string; file?: string | undefined; title?: string | undefined }[] => {
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
  const pages = () => shown().ready?.pages ?? slideList().length;
  const at = () => shown().at?.page ?? 0;
  const frag = () => shown().at?.fragment ?? 0;
  const maxFrag = () => shown().ready?.fragments?.[at()] ?? 0;
  const currentSlide = () => slideList()[at()];
  const currentSlidePath = () => {
    const cur = currentSlide();
    if (!cur) return "project/slides/s01.html";
    const rel = cur.file ?? `${cur.id}.html`;
    return rel.startsWith("project/") ? rel : `project/slides/${rel}`;
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

  const goto = (page: number) => sendTo(frame())({ vibevalley: "goto", page });
  const step = (delta: -1 | 1) => sendTo(frame())({ vibevalley: "step", delta });

  let channel: BroadcastChannel | undefined;
  onSettled(() => {
    channel = new BroadcastChannel(slidesChannelName({ id: props.artifact.id, version: seq() }));
    channel.onmessage = (e: MessageEvent) => {
      const page = slidePostOf(e.data);
      if (page !== undefined) goto(page);
    };
    return () => channel?.close();
  });
  createEffect(at, (page) => channel?.postMessage({ page }));

  const [picked, setPicked] = createSignal<{ readonly anchor: HtmlAnchor; readonly path: string }>();
  const [pickedText, setPickedText] = createSignal("");
  onSettled(() => {
    const heard = (e: MessageEvent) => {
      if (e.source === null || e.source !== frame()?.contentWindow) return;
      const msg = shellMessageOf(e.data);
      if (msg?.vibevalley !== "selection") return;
      setPicked({ anchor: msg.anchor, path: msg.path ?? currentSlidePath() });
      setPickedText(msg.anchor.exact.trim());
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  });

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

  const present = () => {
    const f = frame();
    if (!f) return;
    void f.requestFullscreen().then(() => f.contentWindow?.focus());
  };
  const speaker = () =>
    window.open(presenterHref({ id: props.artifact.id, version: seq() }), `vibevalley-presenter-${props.artifact.id}`, "popup,width=1200,height=760");
  const pdf = () => window.open(storeViewUrl(props.artifact.id, { theme: "light", seq: seq(), print: true }), "_blank", "noopener");
  const slideNumbers = () => Array.from({ length: pages() }, (_, i) => i);

  return (
    <div data-testid="slides-store-view" class="flex min-h-0 min-w-0 flex-1 flex-col">
      <Show when={snapshot().error}>{(err) => <p class="px-3 py-2 text-xs text-berry">{err()}</p>}</Show>
      <iframe
        ref={setFrame}
        data-testid="slides-store-frame"
        title={props.artifact.title}
        src={storeViewUrl(props.artifact.id, { theme: shownTheme(), seq: seq() })}
        sandbox={htmlSandbox}
        referrerpolicy="no-referrer"
        allow="fullscreen"
        class={props.frameStyle ?? "min-h-[54vh] xl:min-h-0 w-full flex-1 rounded-t-lg border border-line bg-side"}
      />
      <div data-testid="slides-store-controls" class="flex shrink-0 flex-col gap-2 border-t border-line bg-page px-3 py-2">
        <div class="flex flex-wrap items-center gap-1.5">
          <IconButton
            icon="previous"
            label={t("web.artifact.slides.previous")}
            testid="slides-previous"
            disabled={at() === 0 && frag() === 0}
            onClick={() => step(-1)}
          />
          <span data-testid="slides-at" class="min-w-16 text-center tabular-nums text-xs text-muted">
            {maxFrag() > 0
              ? t("web.artifact.slidesStore.stepAt", { at: at() + 1, pages: Math.max(1, pages()), frag: frag(), frags: maxFrag() })
              : t("web.artifact.slides.at", { at: at() + 1, pages: Math.max(1, pages()) })}
          </span>
          <IconButton
            icon="next"
            label={t("web.artifact.slides.next")}
            testid="slides-next"
            disabled={at() >= pages() - 1 && frag() >= maxFrag()}
            onClick={() => step(1)}
          />
          <span class="min-w-0 flex-1 truncate text-xs text-faint">{shown().ready?.titles?.[at()] ?? currentSlide()?.title ?? ""}</span>
          <Button data-testid="slides-aspect" disabled={act.busy()} onClick={toggleAspect}>
            {aspect() === "4:3" ? t("web.artifact.slidesStore.aspect4x3") : t("web.artifact.slidesStore.aspect16x9")}
          </Button>
          <Button icon="add" data-testid="slides-add" disabled={act.busy()} onClick={addSlide}>
            {t("web.artifact.slidesStore.addSlide")}
          </Button>
          <IconButton icon="edit" label={t("web.artifact.slidesStore.editSlide")} testid="slides-edit-html" pressed={editingHtml()} onClick={toggleEditHtml} />
          <IconButton icon="present" label={t("web.artifact.slides.present")} testid="slides-present" onClick={present} />
          <IconButton icon="presenter" label={t("web.artifact.slides.presenter")} testid="slides-presenter" onClick={speaker} />
          <IconButton icon="pdf" label={t("web.artifact.slides.pdf")} testid="slides-pdf" onClick={pdf} />
        </div>

        <Show when={picked()}>
          {(sel) => (
            <div data-testid="slides-inline-edit" class="flex flex-col gap-1.5 rounded-md border border-line bg-side p-2.5">
              <blockquote class="line-clamp-2 border-l-2 border-wheat pl-2 text-xs text-muted">{sel().anchor.exact.trim()}</blockquote>
              <TextArea rows={2} value={pickedText()} onInput={(e) => setPickedText(e.currentTarget.value)} />
              <div class="flex justify-end gap-1.5">
                <Button onClick={() => setPicked(undefined)}>{t("web.base.form.never")}</Button>
                <Button tone="primary" disabled={act.busy()} onClick={savePickedWords}>
                  {t("web.artifact.slidesStore.saveSlide")}
                </Button>
              </div>
            </div>
          )}
        </Show>

        <Show when={editingHtml()}>
          <div data-testid="slides-html-drawer" class="flex flex-col gap-2 rounded-md border border-line bg-side p-2.5">
            <span class="font-mono text-xs text-muted">{currentSlidePath()}</span>
            <TextArea rows={6} value={htmlDraft()} onInput={(e) => setHtmlDraft(e.currentTarget.value)} class="font-mono text-xs" />
            <div class="flex justify-end gap-1.5">
              <Button onClick={() => setEditingHtml(false)}>{t("web.base.form.never")}</Button>
              <Button tone="primary" data-testid="slides-save-html" disabled={act.busy()} onClick={saveSlideHtml}>
                {t("web.artifact.slidesStore.saveSlide")}
              </Button>
            </div>
          </div>
        </Show>

        <Show when={pages() > 1}>
          <div role="group" aria-label={t("web.artifact.slides.thumbnails")} data-testid="slides-strip" class="flex gap-2 overflow-x-auto pb-1">
            <For each={slideNumbers()}>
              {(i) => (
                <button
                  type="button"
                  data-testid="slides-thumb"
                  data-page={i}
                  aria-current={i === at() ? "true" : undefined}
                  aria-label={t("web.artifact.slides.slide", { at: i + 1, title: shown().ready?.titles?.[i] ?? "" })}
                  class={[
                    "relative h-18 w-32 shrink-0 cursor-pointer overflow-hidden rounded-md border border-line hover:border-faint bg-side p-0",
                    i === at() && "outline-solid outline-2 outline-accent outline-offset-1",
                  ]}
                  onClick={() => goto(i)}
                >
                  <iframe
                    title={t("web.artifact.slides.slide", { at: i + 1, title: shown().ready?.titles?.[i] ?? "" })}
                    tabindex={-1}
                    aria-hidden="true"
                    src={storeViewUrl(props.artifact.id, { theme: shownTheme(), seq: seq(), at: i, still: true })}
                    sandbox={htmlSandbox}
                    referrerpolicy="no-referrer"
                    loading="lazy"
                    class="h-full w-full pointer-events-none border-0"
                  />
                  <span class="absolute top-1 right-1 rounded-sm bg-page px-1 text-xs text-muted">{i + 1}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
