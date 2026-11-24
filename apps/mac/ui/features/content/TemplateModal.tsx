import { computed, Scroll, signal, Text, untracked, View, windowSize } from "nsh";

import { t } from "@vibevalley/i18n";

import { createAct } from "../../design/act";
import { Dialog } from "../../design/Dialog";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Quiet } from "../../design/layout";
import { motionClass } from "../../design/motion";
import { Segmented } from "../../design/Segmented";
import { mix } from "../../design/tone";
import { spelled } from "../../infra/base/search";
import { ready, useQueryClient } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { useArtifacts } from "../artifact";
import { closeTemplatePicker, type TemplateCategory, templatePickerState } from "./navigation";
import { CONTENT_TEMPLATES, type ContentTemplate, createFromTemplate, TEMPLATE_CATEGORIES, templateDesc, templateName } from "./templates";

export function TemplateModal() {
  const state = () => templatePickerState.get();
  return (
    <Dialog open={state() !== undefined} onClose={closeTemplatePicker} title={t("web.library.content.templates.title")} wide testid="content-template-modal">
      <If when={state()}>{(s) => <TemplateModalBody initialCategory={untracked(() => s().category)} />}</If>
    </Dialog>
  );
}

function TemplateModalBody(props: { initialCategory: TemplateCategory }) {
  const queries = useQueryClient();
  const router = useRouter();
  const artifacts = useArtifacts(() => ({}));
  const act = createAct();
  const category = signal<TemplateCategory>(untracked(() => props.initialCategory));
  const query = signal("");

  const filtered = computed(() => {
    const q = query().trim().toLowerCase();
    return CONTENT_TEMPLATES.filter((tpl) => {
      const catMatch = q ? true : category() === "recommended" ? tpl.recommended : tpl.category === category();
      if (!catMatch) return false;
      if (!q) return true;
      return spelled(templateName(tpl), q) || spelled(templateDesc(tpl), q);
    });
  });
  const hasFiltered = computed(() => filtered().length > 0);
  const categoryOptions = TEMPLATE_CATEGORIES.map((c) => ({
    value: c,
    label: t(`web.library.content.templates.cat.${c}`),
  }));

  const pick = (tpl: ContentTemplate) => {
    if (act.busy()) return;
    const existingNoteTitles = (ready(artifacts, undefined) ?? []).filter((a) => a.artifactType === "outline").map((a) => a.title);
    closeTemplatePicker();
    void act.run(() => createFromTemplate(tpl, { queries, router, existingNoteTitles }));
  };

  return (
    <View class="gap-3.5">
      <View class="flex-row flex-wrap items-center gap-2.5">
        <SearchField
          testid="content-template-search"
          value={query()}
          onInput={(v) => query.set(v)}
          placeholder={t("web.library.content.templates.search")}
          label={t("web.library.content.templates.search")}
          class="w-60 min-w-44"
        />
        <Segmented
          testid="content-template-category"
          label={t("web.library.content.templates.title")}
          value={category()}
          onChange={(v) => category.set(v)}
          options={categoryOptions}
        />
      </View>

      <Scroll style={{ maxHeight: Math.max(280, windowSize().height * 0.62) }} contentClass="pb-1">
        <If when={hasFiltered()} else={<Quiet>{t("web.library.content.templates.empty")}</Quiet>}>
          <View class="flex-row flex-wrap gap-3">
            <Each of={filtered()} key={(tpl) => tpl.id}>
              {(tpl) => (
                <View
                  role="button"
                  testID={`content-template-${tpl().id}`}
                  accessibilityLabel={templateName(tpl())}
                  disabled={act.busy()}
                  onPress={() => pick(tpl())}
                  class={`group w-58 shrink-0 overflow-hidden rounded-lg border border-line bg-page ${motionClass("transition-transform duration-120 ease-out")} hover:border-faint hover:shadow-raise active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
                >
                  <TemplatePreview tpl={tpl()} />
                  <View class="gap-1 p-2.5">
                    <View class="flex-row items-center gap-1.5">
                      <Icon name={tpl().icon} size={14} tone="muted" />
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
    <View class="h-20 w-full items-center justify-center border-b border-line bg-side px-4 py-2.5">
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
            <Icon name={tpl().icon} size={16} tone="ok-ink" />
          </View>
          <View class="gap-1">
            <View class="h-1.5 w-14 rounded-xs bg-ink opacity-70" />
            <View class="h-1.5 w-10 rounded-xs bg-accent opacity-60" />
          </View>
        </View>
      </If>
    </View>
  );
}

function DeliverablePreview(props: { tpl: ContentTemplate }) {
  const artType = () => (props.tpl.kind === "deliverable" ? props.tpl.artifactType : "docs");
  return (
    <View class="h-full w-full items-center justify-center">
      <If when={artType() === "design-system"}>
        <View class="flex-row items-center gap-2">
          <View class="size-8 rounded-md bg-accent" />
          <View class="size-8 rounded-md bg-wheat" />
          <View class="size-8 rounded-md bg-water" />
          <View class="size-8 rounded-md bg-berry" />
        </View>
      </If>
      <If when={artType() === "dashboard"}>
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
      <If when={artType() === "slides"}>
        <View class="h-full w-40 justify-center gap-1.5 rounded-sm border border-line bg-page px-3 py-2">
          <View class="h-1.5 w-10 rounded-xs bg-accent" />
          <View class="h-2 w-24 rounded-xs bg-ink opacity-75" />
          <View class="h-1.5 w-20 rounded-xs bg-faint opacity-50" />
        </View>
      </If>
      <If when={artType() === "design"}>
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
      <If when={artType() === "motion"}>
        <View class="h-full w-40 items-center justify-center gap-1.5 rounded-sm border border-line bg-page px-2.5 py-1.5">
          <View class="size-6 items-center justify-center rounded-full bg-accent">
            <Icon name="play" size={12} tone="page" />
          </View>
          <View class="h-1.5 w-full overflow-hidden rounded-full bg-selected">
            <View class="h-full w-16 rounded-full bg-wheat" />
          </View>
        </View>
      </If>
      <If when={artType() === "prototype"}>
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
      <If when={artType() === "docs" || artType() === "sheet" || artType() === "diagram" || artType() === "storyboard"}>
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
