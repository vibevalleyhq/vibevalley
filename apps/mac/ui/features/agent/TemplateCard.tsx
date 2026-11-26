import { computed, effect, keymap, signal, Text, View } from "nsh";

import { list, t } from "@vibevalley/i18n";
import type { AgentTemplate, RuntimeInfo, TemplateCategory } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { AgentFace, OrchestratorFace } from "../../design/domain/Face";
import { runtimeName } from "../../design/domain/RuntimeBadge";
import { IconButton } from "../../design/IconButton";
import { CountPill, Dot } from "../../design/Tag";
import { toast } from "../../design/toasts";
import { sortRuntimes } from "../../infra/agents";
import { api } from "../../infra/api";
import { ready, useQueryClient } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { useSkills } from "../runtime";
import { localizeAgentProblem } from "./readiness";

export type CategoryFilter = "all" | TemplateCategory;

export function categoryLabel(category: CategoryFilter): string {
  switch (category) {
    case "all":
      return t("web.agent.templates.category.all");
    case "engineering":
      return t("web.agent.templates.category.engineering");
    case "product":
      return t("web.agent.templates.category.product");
    case "research":
      return t("web.agent.templates.category.research");
    case "orchestration":
      return t("web.agent.templates.category.orchestration");
  }
}

export function templateCategoryOf(template: AgentTemplate): TemplateCategory {
  return template.category ?? (template.role === "orchestrator" ? "orchestration" : "engineering");
}

export function matchesTemplateQuery(template: AgentTemplate, needle: string): boolean {
  if (!needle) return true;
  const hay = [template.id, template.name, template.duty, template.style ?? "", template.runtime, ...template.tags, ...template.skills].join(" ").toLowerCase();
  return hay.includes(needle);
}

function resolveTargetRuntime(template: AgentTemplate, runtimes: readonly RuntimeInfo[]): { runtime: string; label: string; ready: boolean } {
  if (template.role === "orchestrator") {
    return { runtime: template.runtime, label: t("web.agent.templates.onServer"), ready: true };
  }
  const isUsable = (r: RuntimeInfo) => r.installation.status === "available" && r.settings.enabled;
  const preferred = runtimes.find((r) => r.id === template.runtime);
  const chosen = preferred && isUsable(preferred) ? preferred : sortRuntimes(runtimes).find(isUsable);
  if (chosen) {
    return { runtime: chosen.id, label: t("web.agent.templates.willUse", { runtime: runtimeName(runtimes, chosen.id) }), ready: true };
  }
  const name = runtimeName(runtimes, template.runtime);
  const install = preferred?.installation;
  switch (install?.status) {
    case "checking":
      return { runtime: template.runtime, label: t("web.runtime.checking"), ready: false };
    case "unsupported":
      return {
        runtime: template.runtime,
        label: install.signInCommand
          ? t("web.runtime.signedOut", { runtime: name })
          : t("web.runtime.unsupportedWhy", { why: localizeAgentProblem(install.reason).text }),
        ready: false,
      };
    default:
      return { runtime: template.runtime, label: t("web.agent.templates.notHere", { runtime: name }), ready: false };
  }
}

export function TemplateCard(props: { template: AgentTemplate; runtimes: readonly RuntimeInfo[]; navigateOnAdopt?: boolean | undefined }) {
  const open = signal(false);
  const confirmingDelete = signal(false);
  const act = createAct();

  effect(() => {
    if (!confirmingDelete()) return;
    return keymap.bind("escape", () => confirmingDelete.set(false), { when: "always" });
  });
  const router = useRouter();
  const client = useQueryClient();
  const library = useSkills();
  const template = () => props.template;
  const orchestrator = () => template().role === "orchestrator";
  const target = computed(() => resolveTargetRuntime(template(), props.runtimes));
  const skills = computed(() => {
    const known = new Map(ready(library, []).map((s) => [s.id, s]));
    return template().skills.map((id) => known.get(id) ?? { id, name: id, description: "" });
  });
  const capabilities = computed(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of [...skills().map((s) => s.name), ...template().tags]) {
      if (!item || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
      if (out.length === 3) break;
    }
    return out;
  });

  const install = () => {
    const id = template().id;
    const runtime = target().runtime;
    const isOrchestrator = orchestrator();
    return act.run(async () => {
      const made = await api.agent.template.install(isOrchestrator ? { id } : { id, runtime });
      await Promise.all([client.invalidate({ prefix: ["agents"] }), client.invalidate({ prefix: ["agent-templates"] })]);
      toast(t("web.agent.templates.adoptedToast", { name: made.name }));
      if (props.navigateOnAdopt === true) {
        router.navigate(`/agents/${encodeURIComponent(made.id)}`);
      }
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
    <View
      accessibilityLabel={template().name}
      testID={`template-${template().id}`}
      class="justify-between gap-3 rounded-xl border border-line bg-elevated p-4 hover:border-line-strong hover:shadow-raise"
    >
      <View class="gap-2.5">
        <View class="flex-row items-center gap-3">
          <View class="size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-side">
            <If
              when={orchestrator()}
              else={<AgentFace agentId={template().id} name={template().name} runtime={target().runtime} look={template().look} size={34} />}
            >
              <OrchestratorFace size={34} look={template().look.orchestrator ?? "farmer"} avatar={template().look.avatar} />
            </If>
          </View>
          <View class="min-w-0 flex-1 gap-0.5">
            <View class="flex-row items-center gap-1.5">
              <Text class="min-w-0 shrink truncate text-sm font-semibold text-ink">{template().name}</Text>
              <View class="shrink-0 rounded-full bg-hover px-2 py-px">
                <Text class="text-2xs font-medium text-muted">{t(`web.agent.role.${template().role}`)}</Text>
              </View>
              <If when={template().installed.length > 0}>
                <CountPill count={t("web.agent.templates.adopted", { n: template().installed.length })} />
              </If>
            </View>
            <If when={template().style}>{(style) => <Text class="truncate text-xs text-muted">{t("web.agent.templates.style", { style: style() })}</Text>}</If>
          </View>
        </View>

        <Text testID={`template-duty-${template().id}`} class="line-clamp-2 min-h-8 text-xs leading-relaxed text-muted">
          {template().duty}
        </Text>

        <If when={capabilities().length > 0}>
          <View class="flex-row flex-wrap gap-1.5">
            <Each of={capabilities()} key={(cap) => cap}>
              {(cap) => (
                <View class="max-w-full rounded-md border border-line bg-side px-1.5 py-0.5">
                  <Text class="truncate text-2xs text-muted">{cap()}</Text>
                </View>
              )}
            </Each>
          </View>
        </If>

        <If when={open()}>
          <View testID="template-persona" class="gap-1.5 rounded-lg border border-line bg-side p-3">
            <If when={template().tags.length > 0}>
              <Text class="text-xs text-muted">{`${t("web.agent.tags")}${t("web.agent.colon")}${list(template().tags)}`}</Text>
            </If>
            <Each of={skills()} key={(s) => s.id}>
              {(s) => (
                <Text testID="template-skill" class="text-xs text-muted">
                  {t("web.agent.templates.skill", { name: s().name, description: s().description })}
                </Text>
              )}
            </Each>
            <Text class="text-2xs font-semibold text-muted">{t("web.agent.personaLabel")}</Text>
            <Text class="text-xs leading-relaxed text-ink">{template().persona || t("web.agent.templates.noPersona")}</Text>
          </View>
        </If>
      </View>

      <View class="mt-3 flex-row items-center justify-between gap-2 border-t border-line pt-2.5">
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Dot tone={target().ready ? "leaf" : "wheat"} size={6} ring={false} />
          <Text class={`min-w-0 flex-1 truncate text-xs ${target().ready ? "text-muted" : "text-warn-ink"}`}>
            {target().label + (template().source === "added" ? t("web.agent.templates.addedHere") : "")}
          </Text>
        </View>
        <View class="shrink-0 flex-row items-center gap-1.5">
          <View class="overflow-hidden rounded-md border border-line bg-side">
            <IconButton
              icon="show"
              size={14}
              label={open() ? t("web.agent.templates.fold") : t("web.agent.templates.preview")}
              testid="template-look"
              pressed={open()}
              onClick={() => open.set(!open())}
            />
          </View>
          <If when={template().source === "added"}>
            <If
              when={confirmingDelete()}
              else={
                <View class="overflow-hidden rounded-md border border-line bg-side">
                  <IconButton
                    icon="delete"
                    size={14}
                    tone="danger"
                    label={t("web.agent.remove")}
                    testid="template-delete"
                    disabled={act.busy()}
                    onClick={() => confirmingDelete.set(true)}
                  />
                </View>
              }
            >
              <View role="group" class="flex-row items-center gap-1">
                <Button
                  tone="danger"
                  size="compact"
                  testID="template-delete-sure"
                  disabled={act.busy()}
                  onPress={() => {
                    confirmingDelete.set(false);
                    void remove();
                  }}
                >
                  {t("web.agent.templates.removeSure")}
                </Button>
                <Button tone="quiet" size="compact" onPress={() => confirmingDelete.set(false)}>
                  {t("web.base.form.never")}
                </Button>
              </View>
            </If>
          </If>
          <Button tone="plain" size="compact" testID="template-install" disabled={act.busy()} onPress={() => void install()}>
            {t("web.agent.templates.adopt")}
          </Button>
        </View>
      </View>
    </View>
  );
}
