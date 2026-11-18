// Ported from VibeValley apps/web/src/features/agent/TemplatesPage.tsx.
// The folder to add from is typed, as there; Return in it adds.
import { Scroll, signal, Text, View } from "nsh";

import { list, t } from "@vibevalley/i18n";
import type { AgentTemplate, RuntimeInfo } from "@vibevalley/protocol";

import { api } from "../../infra/api";
import { ready, useAgentTemplates, useQueryClient, useRuntimes } from "../../infra/query";
import { Link as A, useRouter } from "../../infra/router";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { AgentFace, OrchestratorFace } from "../../ui/domain/Face";
import { runtimeName } from "../../ui/domain/RuntimeBadge";
import { TextInput } from "../../ui/Field";
import { Hint } from "../../ui/Tip";
import { toast } from "../../ui/toasts";
import { useSkills } from "../runtime/SkillsPage";

export function TemplatesPage() {
  const templates = useAgentTemplates();
  const runtimes = useRuntimes();
  const client = useQueryClient();
  const path = signal("");
  const adding = createAct();
  const sorted = () => [...ready(templates, [])].toSorted((a, b) => (a.role === b.role ? 0 : a.role === "orchestrator" ? -1 : 1));
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
    <Scroll testID="templates-page" class="h-full flex-1" contentClass="gap-6 px-4 pt-4 pb-8">
      <View class="gap-1">
        <A href="/agents" class="self-start">
          <Text class="text-xs text-muted hover:underline">{t("web.agent.all")}</Text>
        </A>
        <View class="flex-row items-center gap-1.5">
          <Text role="header" class="text-2xl font-semibold text-ink">
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
          class="min-w-0 flex-1"
        />
        <Button testID="template-add" disabled={adding.busy() || !path().trim()} onPress={() => void add()}>
          {t("web.agent.templates.add")}
        </Button>
      </View>
      <View class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        <Each of={sorted()} key={(template) => template.id}>
          {(template) => (
            <TemplateCard template={template()} runtime={ready(runtimes, []).find((r) => r.id === template().runtime)} runtimes={ready(runtimes, [])} />
          )}
        </Each>
      </View>
    </Scroll>
  );
}

function TemplateCard(props: { template: AgentTemplate; runtime?: RuntimeInfo | undefined; runtimes: readonly RuntimeInfo[] }) {
  const open = signal(false);
  const act = createAct();
  const router = useRouter();
  const client = useQueryClient();
  const template = () => props.template;
  const library = useSkills();
  // The built-in skills it ticks, by their names; an id the library doesn't have (an added template's typo) shows as itself.
  const skills = () => template().skills.map((id) => ready(library, []).find((s) => s.id === id) ?? { id, name: id, description: "" });
  const orchestrator = () => template().role === "orchestrator";
  // An orchestrator runs in the server itself; a helper's runtime may be missing from this machine.
  const here = () => orchestrator() || props.runtime?.installation.status === "available";
  const install = () => {
    const id = template().id;
    return act.run(async () => {
      const made = await api.agent.template.install({ id });
      await Promise.all([client.invalidate({ prefix: ["agents"] }), client.invalidate({ prefix: ["agent-templates"] })]);
      router.navigate(`/agents/${encodeURIComponent(made.id)}`);
    });
  };
  const remove = () => {
    const id = template().id;
    return act.run(async () => {
      await api.agent.template.delete({ id });
      await client.invalidate({ prefix: ["agent-templates"] });
    });
  };
  return (
    <View accessibilityLabel={template().name} testID={`template-${template().id}`} class="gap-3 rounded-lg border border-line bg-page p-4">
      <View class="flex-row items-start gap-3">
        <View class="h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-hover">
          <If
            when={orchestrator()}
            else={<AgentFace agentId={template().id} name={template().name} runtime={template().runtime} look={template().look} size={56} />}
          >
            <OrchestratorFace size={56} look={template().look.orchestrator ?? "farmer"} />
          </If>
        </View>
        <View class="min-w-0 flex-1 gap-0.5">
          <View class="flex-row items-center gap-2">
            <Text class="truncate text-base font-semibold text-ink">{template().name}</Text>
            <View class="shrink-0 rounded-sm bg-hover px-1.5">
              <Text class="text-xs text-muted">{t(`web.agent.role.${template().role}`)}</Text>
            </View>
          </View>
          <Text class="text-sm text-muted" style={{ numberOfLines: 2 }}>
            {template().duty}
          </Text>
          <If when={skills().length > 0}>
            <Text testID="template-skills" class="text-sm text-muted" style={{ numberOfLines: 2 }}>
              {t("web.agent.templates.skills", { skills: list(skills().map((s) => s.name)) })}
            </Text>
          </If>
          <Text class={`text-xs ${here() ? "text-muted" : "text-warn-ink"}`}>
            {orchestrator()
              ? t("web.agent.templates.onServer")
              : here()
                ? t("web.agent.templates.runsOn", { runtime: runtimeName(props.runtimes, template().runtime) })
                : t("web.agent.templates.notHere", { runtime: runtimeName(props.runtimes, template().runtime) })}
          </Text>
        </View>
      </View>
      <If when={open()}>
        <View testID="template-persona" class="gap-2 rounded-md bg-hover p-3">
          <If when={template().tags.length > 0}>
            <Text class="text-sm text-muted">{`${t("web.agent.tags")}${t("web.agent.colon")}${list(template().tags)}`}</Text>
          </If>
          <Each of={skills()}>
            {(s) => (
              <Text testID="template-skill" class="text-sm text-muted">
                {t("web.agent.templates.skill", { name: s().name, description: s().description })}
              </Text>
            )}
          </Each>
          <Text class="text-xs font-medium text-muted">{t("web.agent.personaLabel")}</Text>
          <Text class="text-sm text-ink">{template().persona || t("web.agent.templates.noPersona")}</Text>
        </View>
      </If>
      <View class="mt-auto flex-row flex-wrap items-center gap-2 border-t border-line pt-3">
        <Text class="flex-1 text-xs text-muted">
          {(template().installed.length > 0 ? t("web.agent.templates.installed", { n: template().installed.length }) : "") +
            (template().source === "added" ? t("web.agent.templates.addedHere") : "")}
        </Text>
        <Button testID="template-look" onPress={() => open.set(!open())}>
          {open() ? t("web.agent.templates.fold") : t("web.agent.templates.look")}
        </Button>
        <If when={template().source === "added"}>
          <ConfirmButton label={t("web.agent.remove")} confirm={t("web.agent.templates.removeSure")} onConfirm={remove} />
        </If>
        <Button testID="template-install" disabled={act.busy()} onPress={() => void install()}>
          {t("web.agent.templates.install")}
        </Button>
      </View>
    </View>
  );
}
