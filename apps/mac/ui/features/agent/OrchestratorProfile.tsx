import { computed, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, defaultOrchestrator, orchestratorRuntime, type OrchestratorLook } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { createAct } from "../../design/act";
import { Button, ButtonLink } from "../../design/Button";
import { ConfirmButton } from "../../design/ConfirmButton";
import { orchestratorLooks } from "../../design/domain/cast";
import { OrchestratorFace } from "../../design/domain/Face";
import { Field, TextArea, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Bubble } from "../../design/Tip";
import { api } from "../../infra/api";
import { useQueryClient } from "../../infra/query";
import { Link as A, useRouter } from "../../infra/router";
import { untrack } from "../../infra/solid";
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
  const dirty = computed(() => isNew || !same(props.saved, draft()));
  const nameTaken = computed(() => props.all.some((a) => a.id !== draft().id && a.name === draft().name.trim()));
  const patch = (p: Partial<Agent>) => draft.set({ ...draft(), ...p });
  const setLook = (orchestrator: OrchestratorLook) => patch({ look: { ...draft().look, orchestrator, avatar: undefined } });

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
          <A
            href="/agents"
            testID="back"
            class="group flex-row items-center gap-1 rounded-md px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
          >
            <Icon name="back" size={14} tone="muted" />
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
              class={`shrink-0 rounded-sm px-1.5 py-0.5 ${dirty() ? "bg-warn-soft" : "bg-hover"}`}
            >
              <Text class={`text-xs font-medium ${dirty() ? "text-warn-ink" : "text-muted"}`}>
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
                  <ButtonLink href={runsHref({ session: saved().id })} icon="log" testID="agent-runs-link">
                    {t("web.agent.runsLink")}
                  </ButtonLink>
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
        <View class="gap-1">
          <Text class="text-sm text-muted">{t("web.agent.orchestrator.intro")}</Text>
          <If when={props.saved}>
            {(saved) => (
              <A href={orchestratorHref(saved().id)} class="group flex-row items-center gap-1 self-start rounded-sm py-0.5 hover:bg-hover">
                <Text class="text-sm text-muted underline group-hover:text-ink">{t("web.agent.orchestrator.page")}</Text>
                <Icon name="next" size={13} tone="muted" />
              </A>
            )}
          </If>
        </View>
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
                    class={`items-center gap-1 rounded-lg border p-2 focus-visible:outline-2 focus-visible:outline-focus ${
                      on() ? "border-accent bg-selected" : "border-line hover:border-faint hover:bg-hover"
                    }`}
                  >
                    <OrchestratorFace size={48} look={look().id} />
                    <Text class={`text-xs font-medium ${on() ? "text-ink" : "text-muted"}`}>{look().name}</Text>
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
