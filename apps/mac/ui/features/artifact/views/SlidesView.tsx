import { effect, keymap, Scroll, signal, Text, untracked, View, windowSize } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { Field, TextArea, TextInput } from "../../../design/Field";
import { IconButton } from "../../../design/IconButton";
import { Empty } from "../../../design/layout";
import { Segmented } from "../../../design/Segmented";
import { asString, isRecord } from "./previewModel";

export interface SlideItem {
  readonly id: string;
  readonly file: string;
  readonly title: string;
  readonly subtitle: string;
  readonly layout: string;
  readonly notes: string;
  readonly blocks: readonly Record<string, unknown>[];
}

export interface SlidesViewProps {
  readonly artifactId: string;
  readonly deckTitle: string;
  readonly slides: readonly SlideItem[];
  readonly slideIndex: number;
  readonly version?: number | undefined;
  readonly busy: boolean;
  readonly onSlideIndexChange: (idx: number) => void;
  readonly onAddSlide: () => void;
  readonly onSaveSlide: (
    slide: SlideItem,
    next: { readonly title: string; readonly subtitle: string; readonly layout: string; readonly bullets: readonly string[]; readonly notes: string },
  ) => void;
  readonly onPresent?: ((on: boolean) => void) | undefined;
  readonly onOpenPresenter: () => void;
}

function slideBlockText(blk: Record<string, unknown>): string {
  if (typeof blk.text === "string" && blk.text.trim()) return blk.text;
  const parts = [asString(blk.heading), asString(blk.body)].filter((s) => s.trim().length > 0);
  if (parts.length > 0) return parts.join(" — ");
  if (Array.isArray(blk.items)) {
    const items = blk.items.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    if (items.length > 0) return items.join(" · ");
  }
  if (isRecord(blk.content) && typeof blk.content.text === "string") return blk.content.text;
  return JSON.stringify(blk);
}

export function SlidesView(props: SlidesViewProps) {
  const editing = signal(false);
  const editTitle = signal("");
  const editSubtitle = signal("");
  const editLayout = signal<"cover" | "content">("content");
  const editBullets = signal("");
  const editNotes = signal("");

  const readOnly = () => props.version !== undefined;
  const wideStrip = () => windowSize().width >= 760;
  const currentSlide = () => {
    const list = props.slides;
    if (list.length === 0) return undefined;
    const idx = Math.max(0, Math.min(props.slideIndex, list.length - 1));
    return list[idx];
  };

  const openEditor = () => {
    const s = currentSlide();
    if (!s || readOnly()) return;
    editTitle.set(s.title);
    editSubtitle.set(s.subtitle);
    editLayout.set(s.layout === "cover" ? "cover" : "content");
    editBullets.set(s.blocks.map(slideBlockText).join("\n"));
    editNotes.set(s.notes);
    editing.set(true);
  };

  const saveEdit = () => {
    const s = currentSlide();
    if (!s) return;
    const bullets = untracked(editBullets)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    props.onSaveSlide(s, {
      title: untracked(editTitle).trim() || s.title,
      subtitle: untracked(editSubtitle).trim(),
      layout: untracked(editLayout),
      bullets,
      notes: untracked(editNotes).trim(),
    });
    editing.set(false);
  };

  effect(() => {
    if (editing()) return;
    return keymap.bind(
      {
        left: () => props.onSlideIndexChange(Math.max(0, props.slideIndex - 1)),
        right: () => props.onSlideIndexChange(Math.min(Math.max(0, props.slides.length - 1), props.slideIndex + 1)),
      },
      { when: "notEditing" },
    );
  });

  return (
    <View testID="artifact-slides-view" class="min-h-0 flex-1">
      <View class="min-h-0 flex-1 flex-row bg-side">
        <If when={wideStrip() && props.slides.length > 0}>
          <Scroll testID="slides-filmstrip" class="w-44 shrink-0 border-r border-line bg-page" contentClass="gap-1.5 p-2">
            <Each of={props.slides} key={(s) => s.id}>
              {(s, idx) => {
                const active = () => idx() === props.slideIndex;
                return (
                  <View
                    role="button"
                    testID={`slides-thumb-${idx()}`}
                    accessibilityState={{ selected: active() }}
                    onPress={() => {
                      editing.set(false);
                      props.onSlideIndexChange(idx());
                    }}
                    class={`gap-1 rounded-md border p-2 ${active() ? "border-accent bg-selected" : "border-line bg-side hover:border-faint hover:bg-hover"}`}
                  >
                    <View class="flex-row items-center justify-between gap-1">
                      <Text class="font-mono text-2xs text-faint tabular-nums">{String(idx() + 1).padStart(2, "0")}</Text>
                      <Text class="font-mono text-2xs text-faint">{s().layout}</Text>
                    </View>
                    <Text class={`line-clamp-2 text-xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{s().title}</Text>
                  </View>
                );
              }}
            </Each>
          </Scroll>
        </If>

        <View class="min-h-0 min-w-0 flex-1 items-center justify-center p-6">
          <If when={currentSlide()} else={<Empty icon="present">{t("web.artifact.presenter.empty")}</Empty>}>
            {(slide) => (
              <If
                when={editing() && !readOnly()}
                else={
                  <View
                    class={`aspect-video w-full max-w-3xl rounded-xl border border-line bg-page p-8 shadow-raise ${
                      slide().layout === "cover" ? "items-center justify-center gap-3 text-center" : "justify-center gap-3"
                    }`}
                  >
                    <If when={slide().layout === "cover"}>
                      <View class="h-1 w-12 rounded-full bg-accent" />
                    </If>
                    <Text class="font-mono text-2xs text-accent">{slide().layout.toUpperCase()}</Text>
                    <Text
                      testID="slide-title"
                      class={slide().layout === "cover" ? "text-center text-3xl font-bold text-ink" : "text-2xl font-semibold text-ink"}
                    >
                      {slide().title}
                    </Text>
                    <If when={slide().subtitle}>
                      <Text class={slide().layout === "cover" ? "text-center text-base text-muted" : "text-base text-muted"}>{slide().subtitle}</Text>
                    </If>
                    <If when={slide().blocks.length > 0}>
                      <View class="w-full gap-2 pt-2">
                        <Each of={slide().blocks} key={(_, idx) => String(idx)}>
                          {(blk) => (
                            <View class="flex-row items-start gap-2.5">
                              <View class="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
                              <Text class="min-w-0 flex-1 text-sm leading-relaxed text-ink">{slideBlockText(blk())}</Text>
                            </View>
                          )}
                        </Each>
                      </View>
                    </If>
                    <If when={slide().notes}>
                      <View class="mt-auto w-full border-t border-line pt-2.5">
                        <Text class="text-xs text-faint">{slide().notes}</Text>
                      </View>
                    </If>
                  </View>
                }
              >
                <Scroll class="w-full max-w-2xl rounded-xl border border-line bg-page shadow-raise" contentClass="gap-3 p-5">
                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="text-sm font-semibold text-ink">{t("web.artifact.slides.editSlide")}</Text>
                    <Segmented
                      testid="slides-edit-layout"
                      label={t("web.artifact.slides.slideLayoutLabel")}
                      value={editLayout()}
                      onChange={(v) => editLayout.set(v)}
                      options={[
                        { value: "content", label: t("web.artifact.slides.layoutContent") },
                        { value: "cover", label: t("web.artifact.slides.layoutCover") },
                      ]}
                    />
                  </View>
                  <Field label={t("web.artifact.slides.slideTitleLabel")}>
                    <TextInput testID="slides-edit-title" value={editTitle()} onInput={(v) => editTitle.set(v)} />
                  </Field>
                  <Field label={t("web.artifact.slides.slideSubtitleLabel")}>
                    <TextInput testID="slides-edit-subtitle" value={editSubtitle()} onInput={(v) => editSubtitle.set(v)} />
                  </Field>
                  <Field label={t("web.artifact.slides.slideBulletsLabel")}>
                    <TextArea testID="slides-edit-bullets" rows={5} value={editBullets()} onInput={(v) => editBullets.set(v)} />
                  </Field>
                  <Field label={t("web.artifact.slides.slideNotesLabel")}>
                    <TextArea testID="slides-edit-notes" rows={2} value={editNotes()} onInput={(v) => editNotes.set(v)} />
                  </Field>
                  <View class="flex-row items-center justify-end gap-2">
                    <Button tone="quiet" onPress={() => editing.set(false)}>
                      {t("web.base.form.never")}
                    </Button>
                    <Button tone="primary" testID="slides-edit-save" disabled={props.busy} onPress={saveEdit}>
                      {t("web.artifact.whiteboard.save")}
                    </Button>
                  </View>
                </Scroll>
              </If>
            )}
          </If>
        </View>
      </View>

      <View class="shrink-0 flex-row items-center gap-2 border-t border-line bg-page px-3 py-2">
        <IconButton
          icon="previous"
          label={t("web.artifact.slides.previous")}
          testid="slides-previous"
          disabled={props.slideIndex <= 0}
          onClick={() => {
            editing.set(false);
            props.onSlideIndexChange(Math.max(0, props.slideIndex - 1));
          }}
        />
        <Text testID="slides-at" class="font-mono text-xs text-muted tabular-nums">
          {`${Math.min(props.slideIndex + 1, Math.max(1, props.slides.length))} / ${props.slides.length}`}
        </Text>
        <IconButton
          icon="next"
          label={t("web.artifact.slides.next")}
          testid="slides-next"
          disabled={props.slideIndex >= props.slides.length - 1}
          onClick={() => {
            editing.set(false);
            props.onSlideIndexChange(Math.min(props.slides.length - 1, props.slideIndex + 1));
          }}
        />
        <View class="flex-1" />
        <If when={!readOnly() && currentSlide() !== undefined}>
          <Button
            size="compact"
            icon="edit"
            testID="slides-edit-toggle"
            onPress={() => {
              if (editing()) editing.set(false);
              else openEditor();
            }}
          >
            {editing() ? t("web.artifact.slides.doneEdit") : t("web.artifact.slides.editSlide")}
          </Button>
        </If>
        <If when={!readOnly()}>
          <Button size="compact" icon="add" testID="slides-add" disabled={props.busy} onPress={() => props.onAddSlide()}>
            {t("web.artifact.slidesStore.addSlide")}
          </Button>
        </If>
        <If when={props.onPresent}>
          <IconButton icon="present" label={t("web.artifact.slides.present")} testid="slides-present" onClick={() => props.onPresent?.(true)} />
        </If>
        <IconButton icon="presenter" label={t("web.artifact.slides.presenter")} testid="slides-presenter" onClick={() => props.onOpenPresenter()} />
      </View>
    </View>
  );
}
