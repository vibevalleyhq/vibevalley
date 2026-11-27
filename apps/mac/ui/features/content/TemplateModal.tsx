import { computed, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { NoteType } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Dialog } from "../../design/Dialog";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Quiet } from "../../design/layout";
import { motionClass } from "../../design/motion";
import { Segmented } from "../../design/Segmented";
import { mix } from "../../design/tone";
import { ready, useQueryClient } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { closeTemplatePicker, type TemplateCategory, templatePickerState } from "../../infra/state/contentNav";
import { noteTypeLabel, useNotes } from "../note";
import {
  CONTENT_TEMPLATES,
  type ContentTemplate,
  createFromTemplate,
  type DeliverablePreviewKind,
  TEMPLATE_CATEGORIES,
  templateBadge,
  templateDesc,
  templateIcon,
  templateMatchesQuery,
  templateName,
  templateNoteType,
} from "./templates";

export function TemplateModal() {
  const state = () => templatePickerState.get();
  return (
    <Dialog
      open={state() !== undefined}
      onClose={closeTemplatePicker}
      title={t("web.library.content.templates.title")}
      size="xl"
      height="fixed"
      scroll={false}
      testid="content-template-modal"
    >
      <If when={state()}>{(s) => <TemplateModalBody initialCategory={untracked(() => s().category)} initialNoteType={untracked(() => s().noteType)} />}</If>
    </Dialog>
  );
}

type TemplateTab = TemplateCategory;

function categoryLabel(c: TemplateCategory): string {
  switch (c) {
    case "doc":
    case "base":
    case "canvas":
    case "media":
      return noteTypeLabel(c);
    case "recommended":
    case "apps":
    case "engineering":
    case "ai":
      return t(`web.library.content.templates.cat.${c}`);
  }
}

function TemplateModalBody(props: { initialCategory: TemplateCategory; initialNoteType?: NoteType | undefined }) {
  const queries = useQueryClient();
  const router = useRouter();
  const notes = useNotes(() => ({}));
  const act = createAct();
  const scopedType = untracked(() => props.initialNoteType);
  const initialTab: TemplateTab = scopedType ?? untracked(() => props.initialCategory);
  const selectedTab = signal<TemplateTab>(initialTab);
  const query = signal("");

  const filtered = computed(() => {
    const q = query().trim();
    const tab = selectedTab();
    return CONTENT_TEMPLATES.filter((tpl) => {
      const catMatch = q
        ? true
        : tab === "recommended"
          ? tpl.recommended
          : tab === "apps"
            ? tpl.standaloneApp === true
            : tab === "engineering"
              ? tpl.engineering === true
              : tab === "ai"
                ? tpl.category === "ai"
                : templateNoteType(tpl) === tab;
      if (!catMatch) return false;
      return templateMatchesQuery(tpl, q);
    });
  });
  const hasFiltered = computed(() => filtered().length > 0);
  const categoryOptions: { value: TemplateTab; label: string }[] = TEMPLATE_CATEGORIES.map((c) => ({
    value: c,
    label: categoryLabel(c),
  }));

  const pick = (tpl: ContentTemplate) => {
    if (act.busy()) return;
    const existingNoteTitles = (ready(notes, undefined) ?? []).filter((n) => n.noteType === "doc").map((n) => n.title);
    closeTemplatePicker();
    void act.run(() => createFromTemplate(tpl, { queries, router, existingNoteTitles }));
  };

  return (
    <View class="min-h-0 flex-1">
      <View class="shrink-0 flex-row flex-wrap items-center gap-2.5 border-b border-line px-5 py-3">
        <SearchField
          testid="content-template-search"
          autoFocus
          value={query()}
          onInput={(v) => query.set(v)}
          onSubmit={() => {
            const first = filtered().at(0);
            if (first !== undefined) pick(first);
          }}
          placeholder={t("web.library.content.templates.search")}
          label={t("web.library.content.templates.search")}
          class="w-60 min-w-44"
        />
        <View class={query().trim().length > 0 ? "opacity-50" : undefined}>
          <Segmented
            testid="content-template-category"
            label={t("web.library.content.templates.title")}
            value={selectedTab()}
            onChange={(v) => selectedTab.set(v)}
            options={categoryOptions}
          />
        </View>
        <If when={query().trim().length > 0}>
          <Text testID="content-template-search-count" class="text-xs text-muted tabular-nums">
            {t("web.library.content.templates.searchCount", { n: filtered().length })}
          </Text>
        </If>
      </View>

      <Scroll class="min-h-0 flex-1" contentClass="px-5 py-4">
        <If
          when={hasFiltered()}
          else={
            <View class="py-12">
              <Quiet>{t("web.library.content.templates.empty")}</Quiet>
            </View>
          }
        >
          <View class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            <Each of={filtered()} key={(tpl) => tpl.id}>
              {(tpl) => (
                <View
                  role="button"
                  testID={`content-template-${tpl().id}`}
                  accessibilityLabel={templateName(tpl())}
                  disabled={act.busy()}
                  onPress={() => pick(tpl())}
                  class={`group overflow-hidden rounded-lg border border-line bg-page ${motionClass("transition-transform duration-120 ease-out")} hover:border-faint hover:shadow-raise active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
                >
                  <TemplatePreview tpl={tpl()} />
                  <View class="gap-1 p-2.5">
                    <View class="flex-row items-center gap-1.5">
                      <Icon name={templateIcon(tpl())} size={14} tone="muted" />
                      <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{templateName(tpl())}</Text>
                    </View>
                    <Text class="line-clamp-2 text-xs leading-snug text-muted">{templateDesc(tpl())}</Text>
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
      </Scroll>
    </View>
  );
}

function TemplatePreview(props: { tpl: ContentTemplate }) {
  const tpl = () => props.tpl;
  return (
    <View class="relative h-20 w-full items-center justify-center border-b border-line bg-side px-4 py-2.5">
      <If when={tpl().kind === "note"}>
        <View class="h-full w-full justify-center gap-1.5 rounded-sm border border-line bg-page px-3 py-2">
          <View class="flex-row items-center gap-1.5">
            <View class="size-1.5 rounded-full bg-accent" />
            <View class="h-1.5 w-20 rounded-xs bg-ink opacity-70" />
          </View>
          <View class="flex-row items-center gap-1.5 pl-3">
            <View class="size-1.5 rounded-full bg-faint" />
            <View class="h-1.5 w-24 rounded-xs bg-muted opacity-50" />
          </View>
          <View class="flex-row items-center gap-1.5 pl-3">
            <View class="size-2 rounded-xs border border-accent" />
            <View class="h-1.5 w-16 rounded-xs bg-muted opacity-50" />
          </View>
        </View>
      </If>

      <If when={tpl().kind === "whiteboard"}>
        <View class="h-full w-full flex-row items-center justify-center gap-2">
          <View class="h-9 w-12 justify-center gap-1 rounded-sm border border-line bg-page p-1.5">
            <View class="h-1 w-6 rounded-xs bg-ink opacity-65" />
            <View class="h-1 w-8 rounded-xs bg-faint opacity-45" />
          </View>
          <View class="h-0.5 w-3 bg-accent" />
          <View class="h-10 w-13 justify-center gap-1 rounded-sm border border-leaf bg-ok-soft p-1.5">
            <View class="h-1 w-7 rounded-xs bg-ok-ink opacity-80" />
            <View class="h-1 w-9 rounded-xs bg-ok-ink opacity-45" />
          </View>
          <View class="h-0.5 w-3 bg-water" />
          <View class="h-9 w-12 justify-center gap-1 rounded-sm border p-1.5" style={{ backgroundColor: mix("water", 0.14), borderColor: mix("water", 0.45) }}>
            <View class="h-1 w-6 rounded-xs bg-water opacity-80" />
            <View class="h-1 w-8 rounded-xs bg-water opacity-45" />
          </View>
        </View>
      </If>

      <If when={tpl().kind === "deliverable"}>
        <DeliverablePreview tpl={tpl()} />
      </If>

      <If when={tpl().kind === "ai"}>
        <View class="flex-row items-center gap-2.5 rounded-md border border-line bg-page px-3.5 py-2">
          <View class="size-7 items-center justify-center rounded-md bg-ok-soft">
            <Icon name={templateIcon(tpl())} size={16} tone="ok-ink" />
          </View>
          <View class="gap-1">
            <View class="h-1.5 w-14 rounded-xs bg-ink opacity-70" />
            <View class="h-1.5 w-10 rounded-xs bg-accent opacity-60" />
          </View>
        </View>
      </If>

      <View class="absolute top-1.5 right-1.5 flex-row items-center gap-1">
        <If when={tpl().standaloneApp === true}>
          <View class="size-5 items-center justify-center rounded-sm border border-line bg-page">
            <Icon name="devices" size={12} tone="accent" />
          </View>
        </If>
        <View class="rounded-sm border border-line bg-page px-1.5 py-0.5">
          <Text class="text-2xs font-medium text-muted">{templateBadge(tpl())}</Text>
        </View>
      </View>
    </View>
  );
}

function DeliverablePreview(props: { tpl: ContentTemplate }) {
  const previewKind = (): DeliverablePreviewKind => (props.tpl.kind === "deliverable" ? props.tpl.previewShape : "document");
  return (
    <View class="h-full w-full items-center justify-center">
      <If when={previewKind() === "design-system"}>
        <View class="flex-row items-center gap-2">
          <View class="size-8 rounded-md bg-accent" />
          <View class="size-8 rounded-md bg-wheat" />
          <View class="size-8 rounded-md bg-water" />
          <View class="size-8 rounded-md bg-berry" />
        </View>
      </If>
      <If when={previewKind() === "dashboard"}>
        <View class="h-full w-full gap-1.5">
          <View class="flex-row gap-1.5">
            <View class="h-5 flex-1 justify-center rounded-sm border border-line bg-page px-1.5">
              <View class="h-1.5 w-6 rounded-xs bg-accent" />
            </View>
            <View class="h-5 flex-1 justify-center rounded-sm border border-line bg-page px-1.5">
              <View class="h-1.5 w-7 rounded-xs bg-water" />
            </View>
            <View class="h-5 flex-1 justify-center rounded-sm border border-line bg-page px-1.5">
              <View class="h-1.5 w-5 rounded-xs bg-wheat" />
            </View>
          </View>
          <View class="flex-1 flex-row items-end gap-1.5 rounded-sm border border-line bg-page px-2 py-1">
            <View class="h-2.5 flex-1 rounded-xs bg-ok-soft" />
            <View class="h-4 flex-1 rounded-xs bg-accent opacity-70" />
            <View class="h-3 flex-1 rounded-xs bg-ok-soft" />
            <View class="h-5 flex-1 rounded-xs bg-accent" />
          </View>
        </View>
      </If>
      <If when={previewKind() === "slides"}>
        <View class="h-full w-40 justify-center gap-1.5 rounded-sm border border-line bg-page px-3 py-2">
          <View class="h-1.5 w-10 rounded-xs bg-accent" />
          <View class="h-2 w-24 rounded-xs bg-ink opacity-75" />
          <View class="h-1.5 w-20 rounded-xs bg-faint opacity-50" />
        </View>
      </If>
      <If when={previewKind() === "design"}>
        <View class="h-full w-full flex-row items-center justify-center gap-2">
          <View class="h-full w-18 gap-1 rounded-sm border border-line bg-page p-1.5">
            <View class="h-3 rounded-xs bg-selected" />
            <View class="h-1.5 w-10 rounded-xs bg-faint opacity-50" />
          </View>
          <View class="h-full w-18 gap-1 rounded-sm border border-accent bg-page p-1.5">
            <View class="h-3 rounded-xs bg-ok-soft" />
            <View class="h-1.5 w-10 rounded-xs bg-accent opacity-70" />
          </View>
        </View>
      </If>
      <If when={previewKind() === "motion"}>
        <View class="h-full w-40 items-center justify-center gap-1.5 rounded-sm border border-line bg-page px-2.5 py-1.5">
          <View class="size-6 items-center justify-center rounded-full bg-accent">
            <Icon name="play" size={12} tone="page" />
          </View>
          <View class="h-1.5 w-full overflow-hidden rounded-full bg-selected">
            <View class="h-full w-16 rounded-full bg-wheat" />
          </View>
        </View>
      </If>
      <If when={previewKind() === "prototype"}>
        <View class="h-full w-40 overflow-hidden rounded-sm border border-line bg-page">
          <View class="h-3.5 flex-row items-center gap-1 bg-selected px-2">
            <View class="size-1.5 rounded-full bg-berry opacity-75" />
            <View class="size-1.5 rounded-full bg-wheat opacity-75" />
            <View class="size-1.5 rounded-full bg-leaf opacity-75" />
          </View>
          <View class="flex-1 items-center justify-center gap-1.5 px-3">
            <View class="h-2 w-24 rounded-xs bg-ink opacity-70" />
            <View class="h-2.5 w-14 rounded-xs bg-accent" />
          </View>
        </View>
      </If>
      <If when={previewKind() === "diagram"}>
        <View class="h-full w-full flex-row items-center justify-center gap-1.5">
          <View class="h-7 w-10 items-center justify-center rounded-sm border border-line bg-page">
            <View class="h-1.5 w-5 rounded-xs bg-ink opacity-70" />
          </View>
          <View class="h-0.5 w-3 bg-accent" />
          <View class="h-7 w-10 items-center justify-center rounded-sm border border-accent bg-ok-soft">
            <View class="h-1.5 w-5 rounded-xs bg-ok-ink opacity-80" />
          </View>
          <View class="h-0.5 w-3 bg-water" />
          <View class="h-7 w-10 items-center justify-center rounded-sm border border-line bg-page">
            <View class="h-1.5 w-5 rounded-xs bg-water opacity-80" />
          </View>
        </View>
      </If>
      <If when={previewKind() === "sheet"}>
        <View class="h-full w-40 justify-center gap-1 rounded-sm border border-line bg-page p-2">
          <View class="flex-row gap-1 border-b border-line pb-1">
            <View class="h-1.5 flex-1 rounded-xs bg-accent opacity-75" />
            <View class="h-1.5 flex-1 rounded-xs bg-ink opacity-60" />
            <View class="h-1.5 flex-1 rounded-xs bg-ink opacity-60" />
          </View>
          <View class="flex-row gap-1">
            <View class="h-1.5 flex-1 rounded-xs bg-faint opacity-50" />
            <View class="h-1.5 flex-1 rounded-xs bg-faint opacity-45" />
            <View class="h-1.5 flex-1 rounded-xs bg-ok-soft" />
          </View>
          <View class="flex-row gap-1">
            <View class="h-1.5 flex-1 rounded-xs bg-faint opacity-50" />
            <View class="h-1.5 flex-1 rounded-xs bg-faint opacity-45" />
            <View class="h-1.5 flex-1 rounded-xs bg-wheat opacity-65" />
          </View>
        </View>
      </If>
      <If when={previewKind() === "storyboard"}>
        <View class="h-full w-full flex-row items-center justify-center gap-1.5">
          <View class="h-11 w-12 justify-between rounded-sm border border-line bg-page p-1">
            <View class="h-5 rounded-xs bg-selected" />
            <View class="h-1 w-6 rounded-xs bg-faint opacity-50" />
          </View>
          <View class="h-11 w-12 justify-between rounded-sm border border-accent bg-page p-1">
            <View class="h-5 rounded-xs bg-ok-soft" />
            <View class="h-1 w-7 rounded-xs bg-accent opacity-70" />
          </View>
          <View class="h-11 w-12 justify-between rounded-sm border border-line bg-page p-1">
            <View class="h-5 rounded-xs bg-selected" />
            <View class="h-1 w-6 rounded-xs bg-faint opacity-50" />
          </View>
        </View>
      </If>
      <If when={previewKind() === "document"}>
        <View class="h-full w-40 justify-center gap-1.5 rounded-sm border border-line bg-page px-3 py-2">
          <View class="h-2 w-18 rounded-xs bg-ink opacity-75" />
          <View class="h-1.5 w-28 rounded-xs bg-faint opacity-50" />
          <View class="h-1.5 w-24 rounded-xs bg-faint opacity-50" />
          <View class="h-2.5 w-full rounded-xs bg-ok-soft" />
        </View>
      </If>
    </View>
  );
}
