import { cleanup, computed, keymap, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { DocBlock, DocView, IssueId, NoteId } from "@vibevalley/protocol";

import { IconButton } from "../../design/IconButton";
import { Empty, Kbd } from "../../design/layout";
import { reasonOf } from "../../infra/api";
import { useNow } from "../../infra/base/dom";
import { useBoardSlice } from "../../infra/frame";
import { ready, useQuery } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { useVdpNode } from "../../infra/vdpProbe";
import { InlineRichText } from "./doc/InlineRichText";
import { noteHref, useNote, useNotes } from "./NoteCard";
import { elapsedText, presenterOf, stepped } from "./slides";
import { noteDocQuery } from "./store";

interface SlideItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly notes: string;
  readonly blocks: readonly DocBlock[];
}

function summarizeBlock(block: DocBlock): string {
  switch (block.type) {
    case "heading":
    case "prose":
    case "todo":
    case "quote":
      return block.text;
    case "callout":
      return [block.title, block.text].filter(Boolean).join(" — ");
    case "list":
      return block.items.join(" · ");
    case "toggle":
      return block.title;
    case "code":
      return block.language ? `[${block.language}]` : "[code]";
    case "table":
      return block.headers.join(" | ");
    case "bookmark":
      return block.title ?? block.url;
    case "diagram":
      return block.title ?? "Diagram";
    case "chart":
      return block.title ?? "Chart";
    case "math":
      return block.expression;
    case "kpi":
      return block.items.map((k) => `${k.label}: ${k.value}`).join(" · ");
    case "pageBreak":
      return block.title ?? "";
    case "divider":
    case "toc":
    case "columns":
    case "compare":
    case "media":
    case "preview":
    case "baseEmbed":
    case "issueCard":
    case "issueList":
      return "";
  }
}

function buildSlidesFromDoc(doc: DocView | undefined, fallbackTitle: string): readonly SlideItem[] {
  if (!doc || doc.blocks.length === 0) return [];
  const slides: SlideItem[] = [];
  let curTitle = fallbackTitle || doc.title;
  let curNotes = "";
  let curBlocks: DocBlock[] = [];
  let idx = 0;

  const flush = () => {
    if (curBlocks.length === 0 && slides.length > 0 && !curTitle && !curNotes) return;
    idx += 1;
    const heading = curBlocks.find((b) => b.type === "heading");
    const prose = curBlocks.find((b) => b.type === "prose" && b.text.trim() !== "");
    const title = heading && heading.type === "heading" ? heading.text : curTitle || `${doc.title} (${idx})`;
    const subtitle = prose && prose.type === "prose" ? prose.text : "";
    slides.push({
      id: `slide-${idx}`,
      title,
      subtitle,
      notes: curNotes,
      blocks: curBlocks,
    });
  };

  for (const block of doc.blocks) {
    if (block.type === "pageBreak") {
      if (curBlocks.length > 0 || slides.length === 0) {
        flush();
      }
      curTitle = block.title ?? "";
      curNotes = block.speakerNotes ?? "";
      curBlocks = [];
      continue;
    }
    curBlocks.push(block);
  }
  if (curBlocks.length > 0 || curTitle !== "" || curNotes !== "" || slides.length === 0) {
    flush();
  }
  return slides;
}

export function PresenterPage() {
  useVdpNode({ testId: "presenter-page", role: "region" });
  const router = useRouter();
  const asked = () => presenterOf(`?${router.path().split("?")[1] ?? ""}`);
  return (
    <If
      when={asked()}
      else={
        <View class="h-full flex-1 bg-page">
          <Empty icon="presenter">{t("web.note.page.gone")}</Empty>
        </View>
      }
    >
      {(a) => <Presenter id={a().id} version={a().version} />}
    </If>
  );
}

function Presenter(props: { id: string; version: number }) {
  const router = useRouter();
  const board = useBoardSlice();
  const note = useNote(() => props.id);
  const allNotes = useNotes(() => ({}));
  const docQuery = useQuery(() => noteDocQuery(props.id));
  const at = signal(0);

  const notesList = computed(() => ready(allNotes, []));
  const issuesList = computed(() => board()?.issues ?? []);
  const slides = computed((): readonly SlideItem[] => buildSlidesFromDoc(ready(docQuery, undefined), note.data()?.title ?? ""));
  const pages = () => slides().length;
  const current = () => slides()[at()];
  const nextSlide = () => slides()[at() + 1];
  const openNote = (nid: NoteId) => router.navigate(noteHref(nid));
  const openIssue = (iid: IssueId) => router.navigate(`/issues/${encodeURIComponent(iid)}`);
  const statusText = () => {
    const err = docQuery.error();
    if (err) return reasonOf(err);
    return docQuery.status() === "pending" ? t("web.note.timeline.loading") : t("web.note.doc.empty");
  };
  const goBack = () => router.navigate(noteHref(props.id, props.version > 0 ? props.version : undefined));
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
  const title = () => note.data()?.title ?? ready(docQuery, undefined)?.title ?? "";
  const notes = () => current()?.notes ?? "";

  return (
    <View testID="presenter" accessibilityValue={{ now: at(), max: pages() }} class="h-full min-h-0 flex-1 bg-side">
      <View class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
        <IconButton icon="back" size={16} label={t("web.note.page.all")} testid="presenter-back" onClick={goBack} />
        <View class="h-4 w-px bg-line" />
        <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title()}</Text>
        <View class="flex-row items-center gap-1.5">
          <IconButton
            icon="previous"
            size={16}
            label={t("web.base.lightbox.prev")}
            testid="presenter-previous"
            disabled={at() === 0}
            onClick={() => step(-1)}
          />
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
          <IconButton
            icon="next"
            size={16}
            label={t("web.base.lightbox.next")}
            testid="presenter-next"
            disabled={at() >= pages() - 1}
            onClick={() => step(1)}
          />
        </View>
        <View class="mx-1 h-4 w-px bg-line" />
        <View class="flex-row items-center gap-1.5">
          <Text testID="presenter-clock" class="font-mono text-sm font-semibold text-ink tabular-nums">
            {elapsedText(now() - started())}
          </Text>
          <IconButton icon="refresh" size={16} label={t("web.base.form.reset")} testid="presenter-restart" onClick={() => started.set(now())} />
        </View>
      </View>

      <View class="min-h-0 flex-1 gap-4 p-4 md:flex-row">
        <View class="min-h-0 gap-3 md:flex-2">
          <View testID="presenter-current" class="aspect-video w-full overflow-hidden rounded-lg border border-line bg-page shadow-raise">
            <Scroll class="min-h-0 flex-1" contentClass="min-h-full justify-center gap-3 p-8">
              <If when={current()}>
                {(slide) => (
                  <>
                    <Text class="text-2xl font-semibold text-ink">{slide().title}</Text>
                    <If when={slide().subtitle}>
                      <InlineRichText
                        text={slide().subtitle}
                        textClass="text-base"
                        toneClass="text-muted"
                        containerClass="px-0"
                        notes={notesList()}
                        issues={issuesList()}
                        onOpenNote={openNote}
                        onOpenIssue={openIssue}
                      />
                    </If>
                    <View class="gap-1.5 pt-2">
                      <Each
                        of={slide()
                          .blocks.filter((b) => b.type !== "heading" && !(b.type === "prose" && b.text === slide().subtitle))
                          .slice(0, 6)}
                        key={(b) => b.id}
                      >
                        {(block) => {
                          const line = () => summarizeBlock(block());
                          return (
                            <If when={line() !== ""}>
                              <InlineRichText
                                text={line()}
                                textClass="text-sm"
                                containerClass="px-0"
                                notes={notesList()}
                                issues={issuesList()}
                                onOpenNote={openNote}
                                onOpenIssue={openIssue}
                              />
                            </If>
                          );
                        }}
                      </Each>
                    </View>
                  </>
                )}
              </If>
            </Scroll>
          </View>
          <View class="flex-row flex-wrap items-center justify-between gap-2 px-0.5">
            <View class="flex-row items-center gap-1.5">
              <Kbd size="md">←</Kbd>
              <Kbd size="md">→</Kbd>
              <Text class="text-xs text-faint">{t("web.base.shortcuts.say.flip")}</Text>
            </View>
            <View class="flex-row items-center gap-1.5">
              <Kbd size="md">Esc</Kbd>
              <Text class="text-xs text-faint">{t("web.note.page.all")}</Text>
            </View>
          </View>
        </View>

        <View class="min-h-0 gap-3 md:flex-1">
          <View class="gap-1.5">
            <View class="flex-row items-center justify-between gap-2 px-0.5">
              <Text class="text-xs font-semibold text-muted">{t("web.base.lightbox.next")}</Text>
              <If when={pages() > 0 && at() < pages() - 1}>
                <Text class="font-mono text-2xs text-faint tabular-nums">{`${at() + 2} / ${pages()}`}</Text>
              </If>
            </View>
            <If
              when={nextSlide()}
              else={
                <View class="aspect-video w-full items-center justify-center rounded-lg border border-dashed border-line bg-page">
                  <If when={pages() > 0}>
                    <Text class="text-xs text-faint">{t("web.note.doc.slidesCount", { n: pages() })}</Text>
                  </If>
                </View>
              }
            >
              {(slide) => (
                <View
                  testID="presenter-next-slide"
                  class="aspect-video w-full justify-center gap-1.5 overflow-hidden rounded-lg border border-line bg-page p-4 shadow-raise"
                >
                  <Text class="truncate text-base font-semibold text-ink">{slide().title}</Text>
                  <If when={slide().subtitle}>
                    <InlineRichText
                      text={slide().subtitle}
                      textClass="text-xs"
                      toneClass="text-muted"
                      containerClass="px-0"
                      notes={notesList()}
                      issues={issuesList()}
                      onOpenNote={openNote}
                      onOpenIssue={openIssue}
                    />
                  </If>
                </View>
              )}
            </If>
          </View>
          <View class="min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-page">
            <View class="shrink-0 border-b border-line px-3.5 py-2">
              <Text class="text-xs font-semibold text-muted">{t("web.note.page.rail")}</Text>
            </View>
            <Scroll class="min-h-0 flex-1" contentClass="p-3.5">
              <Text testID="presenter-notes" class={notes() ? "text-sm leading-relaxed text-ink" : "text-sm text-faint"}>
                {pages() > 0 ? notes() || t("web.base.form.none") : ""}
              </Text>
            </Scroll>
          </View>
        </View>
      </View>
    </View>
  );
}
