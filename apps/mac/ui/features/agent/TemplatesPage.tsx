import { Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { TemplateCategoryValues } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { TextInput } from "../../design/Field";
import { PageBody } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { Hint } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { api } from "../../infra/api";
import { ready, useAgentTemplates, useQueryClient, useRuntimes } from "../../infra/query";
import { Link as A } from "../../infra/router";
import { type CategoryFilter, categoryLabel, TemplateCard, templateCategoryOf } from "./TemplateCard";

export function TemplatesPage() {
  const templates = useAgentTemplates();
  const runtimes = useRuntimes();
  const client = useQueryClient();
  const category = signal<CategoryFilter>("all");
  const path = signal("");
  const adding = createAct();
  const all = () => ready(templates, []);
  const filtered = () => (category() === "all" ? all() : all().filter((tpl) => templateCategoryOf(tpl) === category()));
  const add = () => {
    const at = path().trim();
    if (!at) return;
    return adding.run(async () => {
      const got = await api.agent.template.add({ path: at });
      await client.invalidate({ prefix: ["agent-templates"] });
      path.set("");
      toast(t("web.agent.templates.added", { name: got.name }));
    });
  };
  return (
    <Scroll testID="templates-page" class="h-full flex-1 bg-page" contentClass="px-5 pt-4 pb-8">
      <PageBody width="manage" class="gap-5">
        <View class="gap-1">
          <A
            href="/agents"
            class="group self-start rounded-md px-1.5 py-0.5 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
          >
            <Text class="text-xs text-muted group-hover:text-ink">{t("web.agent.all")}</Text>
          </A>
          <View class="flex-row items-center gap-1.5">
            <Text role="header" class="text-xl font-semibold text-ink">
              {t("web.agent.templates.title")}
            </Text>
            <Hint text={t("web.agent.templates.intro")} />
          </View>
        </View>
        <View class="flex-row items-center gap-2">
          <TextInput
            testID="template-folder"
            accessibilityLabel={t("web.agent.templates.folder")}
            placeholder={t("web.agent.templates.folderHint")}
            value={path()}
            onInput={(v) => path.set(v)}
            onSubmit={() => void add()}
            wide={false}
            class="h-7 min-w-0 flex-1"
          />
          <Button testID="template-add" disabled={adding.busy() || !path().trim()} onPress={() => void add()}>
            {t("web.agent.templates.add")}
          </Button>
        </View>
        <Segmented
          testid="templates-category-filter"
          label={t("web.agent.templates.title")}
          value={category()}
          onChange={(v) => category.set(v)}
          options={[
            { value: "all", label: categoryLabel("all"), count: all().length },
            ...TemplateCategoryValues.map((cat) => ({
              value: cat,
              label: categoryLabel(cat),
              count: all().filter((tpl) => templateCategoryOf(tpl) === cat).length,
            })),
          ]}
        />
        <View class="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          <Each of={filtered()} key={(template) => template.id}>
            {(template) => <TemplateCard template={template()} runtimes={ready(runtimes, [])} navigateOnAdopt />}
          </Each>
        </View>
      </PageBody>
    </Scroll>
  );
}
