// Ported from VibeValley apps/web/src/features/agent/OrchestratorProfile.tsx:
// the same profile bar, fields and looks (base-ui's RadioGroup is a row
// of radio tiles here). The orchestrator's own page is phase 2.
import { Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, defaultOrchestrator, orchestratorRuntime, type OrchestratorLook } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { untrack } from "../../../solid";
import { api } from "../../infra/api";
import { useQueryClient } from "../../infra/query";
import { Link as A, useRouter } from "../../infra/router";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { OrchestratorFace } from "../../ui/domain/Face";
import { Field, TextArea, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Bubble } from "../../ui/Tip";
import { mix } from "../../ui/tone";
import { orchestratorLooks } from "../orchestrator/looks";
import { runsHref } from "../session";
import { FromTemplate } from "./FromTemplate";

/** features/orchestrator/OrchestratorPage.tsx's, which comes with phase 2. */
export const orchestratorHref = (agent: string, tab = "memory") =>
  agent === defaultOrchestrator ? `/orchestrator/${tab}` : `/orchestrator/${encodeURIComponent(agent)}/${tab}`;

export function newOrchestrator(): Agent {
  return {
    id: "",
    name: t("web.agent.orchestrator.newName"),
    role: "orchestrator",
    duty: "",
    enabled: true,
    runtime: orchestratorRuntime,
    model: "",
    effort: "",
    persona: "",
    personaMode: "append",
    skills: [],
    mcpServers: [],
    disallowedTools: [],
    env: {},
    workdir: "",
    worktree: false,
    tags: [],
    look: { species: null, outfit: null, build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "", orchestrator: "foreman" },
  };
}

export function OrchestratorProfile(props: { saved?: Agent | undefined; start: Agent; all: readonly Agent[] }) {
  const isNew = untrack(() => !props.saved);
  const draft = signal(untrack(() => props.start));
  const saving = createAct();
  const act = createAct();
  const router = useRouter();
  const client = useQueryClient();
  const dirty = () => isNew || !same(props.saved, draft());
  const nameTaken = () => props.all.some((a) => a.id !== draft().id && a.name === draft().name.trim());
  const patch = (p: Partial<Agent>) => draft.set({ ...draft(), ...p });
  const setLook = (orchestrator: OrchestratorLook) => patch({ look: { ...draft().look, orchestrator } });

  const save = () => {
    const d = draft();
    const body = { ...d, name: d.name.trim() || t("web.agent.orchestrator.newName") };
    return saving.run(async () => {
      const got = isNew ? await api.agent.create(body) : await api.agent.update(body);
      await client.invalidate({ prefix: ["agents"] });
      draft.set(got);
      if (isNew) router.navigate(`/agents/${encodeURIComponent(got.id)}`);
    });
  };
  const remove = () => {
    const id = draft().id;
    return act.run(async () => {
      await api.agent.delete({ id });
      await client.invalidate({ prefix: ["agents"] });
      router.navigate("/agents");
    });
  };
  const talk = () => {
    const agent = draft().id;
    void act.run(async () => router.navigate(`/chat/${await api.channel.direct.create({ agent })}`));
  };

  return (
    <Scroll testID="orchestrator-profile" class="h-full flex-1 bg-page" contentClass="px-5 pb-8">
      <View class="max-w-3xl gap-4">
        <View testID="profile-bar" class="flex-row flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-line py-3">
          <A href="/agents" testID="back" class="group rounded-md px-1.5 py-0.5 transition duration-120 ease-out hover:bg-hover">
            <Text class="text-sm text-muted group-hover:text-ink">{t("web.agent.all")}</Text>
          </A>
          <Text class="text-sm text-faint">/</Text>
          <View class="min-w-0 flex-1 flex-row items-center gap-2.5">
            <Text class="truncate text-lg font-semibold text-ink">{draft().name || t("web.agent.unnamed")}</Text>
            <View class="shrink-0 rounded-sm bg-hover px-1.5 py-0.5">
              <Text class="text-xs font-medium text-muted">{t("web.agent.role.orchestrator")}</Text>
            </View>
            <View
              testID={`profile-${isNew ? "new" : dirty() ? "dirty" : "saved"}`}
              class={`shrink-0 rounded-sm px-1.5 py-0.5 ${dirty() ? "bg-hat" : "bg-hover"}`}
            >
              <Text class={`text-xs font-medium ${dirty() ? "text-bark-900" : "text-muted"}`}>
                {isNew ? t("web.agent.isNew") : dirty() ? t("web.agent.unsaved") : t("web.agent.saved")}
              </Text>
            </View>
          </View>
          <View class="flex-row flex-wrap items-center gap-2">
            <If when={props.saved}>
              {(saved) => (
                <>
                  <If when={saved().id !== defaultOrchestrator}>
                    <ConfirmButton
                      label={t("web.agent.remove")}
                      question={t("web.agent.removeWhich", { name: saved().name })}
                      testid="delete"
                      onConfirm={remove}
                    />
                  </If>
                  <A
                    href={runsHref({ session: saved().id })}
                    testID="agent-runs-link"
                    class="h-7 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2.5 transition duration-120 ease-out hover:border-faint hover:bg-hover active:translate-y-px"
                  >
                    <Icon name="log" size={14} tone="muted" />
                    <Text class="text-sm text-ink">{t("web.agent.runsLink")}</Text>
                  </A>
                  <Button icon="thread" testID="talk" disabled={act.busy()} onPress={talk}>
                    {t("web.agent.talk")}
                  </Button>
                  <If when={dirty()}>
                    <Button tone="quiet" testID="discard" onPress={() => draft.set(saved())}>
                      {t("web.agent.discard")}
                    </Button>
                  </If>
                </>
              )}
            </If>
            <Button tone="primary" testID="save" disabled={!dirty() || saving.busy() || nameTaken()} onPress={() => void save()}>
              {saving.busy() ? t("web.agent.saving") : isNew ? t("web.agent.create") : t("web.agent.save")}
            </Button>
          </View>
        </View>
        <If when={props.saved}>{(saved) => <FromTemplate agent={saved()} onUpdated={(a) => draft.set(a)} />}</If>
        <Text class="text-sm text-muted">
          {`${t("web.agent.orchestrator.intro")} `}
          <If when={props.saved}>
            {(saved) => (
              <Text class="text-sm text-muted underline" onPress={() => router.navigate(orchestratorHref(saved().id))}>
                {t("web.agent.orchestrator.page")}
              </Text>
            )}
          </If>
        </Text>
        <View class="grid gap-4 sm:grid-cols-2">
          <Field label={t("web.agent.name")} hint={nameTaken() ? t("web.agent.nameTaken") : t("web.agent.orchestrator.nameTip")}>
            <TextInput testID="agent-name" accessibilityLabel={t("web.agent.name")} value={draft().name} onInput={(name) => patch({ name })} />
          </Field>
          <Field label={t("web.agent.orchestrator.model")} hint={t("web.agent.orchestrator.modelTip")}>
            <TextInput
              accessibilityLabel={t("web.agent.orchestrator.model")}
              value={draft().model}
              placeholder={t("web.agent.orchestrator.modelHint")}
              onInput={(model) => patch({ model })}
            />
          </Field>
        </View>
        <Field label={t("web.agent.duty")} hint={t("web.agent.orchestrator.dutyTip")}>
          <TextInput testID="agent-duty" accessibilityLabel={t("web.agent.duty")} value={draft().duty} onInput={(duty) => patch({ duty })} />
        </Field>
        <Field label={t("web.agent.personaLabel")} hint={t("web.agent.orchestrator.personaTip")}>
          <TextArea
            rows={5}
            accessibilityLabel={t("web.agent.personaLabel")}
            value={draft().persona}
            placeholder={t("web.agent.orchestrator.personaHint")}
            onInput={(persona) => patch({ persona })}
          />
        </Field>
        <View class="gap-2">
          <Text class="text-xs font-medium text-muted">{t("web.agent.orchestrator.look")}</Text>
          <View role="radiogroup" accessibilityLabel={t("web.agent.orchestrator.look")} class="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <Each of={orchestratorLooks}>
              {(look) => {
                const on = () => (draft().look.orchestrator ?? "farmer") === look().id;
                return (
                  <View
                    role="radio"
                    testID={`look-${look().id}`}
                    accessibilityLabel={look().name}
                    accessibilityState={{ checked: on() }}
                    tooltip={<Bubble text={look().blurb} />}
                    onPress={() => setLook(look().id)}
                    class={`items-center gap-1 rounded-lg border p-2 transition duration-120 ease-out ${on() ? "bg-selected" : "border-line hover:bg-hover"}`}
                    style={on() ? { borderColor: mix("leaf", 1) } : undefined}
                  >
                    <OrchestratorFace size={48} look={look().id} />
                    <Text class={`text-xs ${on() ? "font-semibold text-ink" : "text-muted"}`}>{look().name}</Text>
                  </View>
                );
              }}
            </Each>
          </View>
        </View>
      </View>
    </Scroll>
  );
}
