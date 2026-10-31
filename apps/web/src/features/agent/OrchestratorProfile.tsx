// An orchestrator's profile, made or edited: its name, what it does, its persona, its DeepSeek model and its look. It
// runs on VibeValley's own agent only, so it has no machine to pick; its memory and rounds are on its orchestrator page.

import { useQueryClient } from "@tanstack/solid-query";
import { createSignal, For, Show, untrack } from "solid-js";

import { Radio, RadioGroup } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";
import { type Agent, defaultOrchestrator, orchestratorRuntime, type OrchestratorLook, OrchestratorLookValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { api } from "@/base/api";
import { useRouter } from "@/base/router";
import { orchestratorHref, orchestratorLooks } from "@/features/orchestrator";
import { A } from "@/ui/A";
import { createAct } from "@/ui/act";
import { Button } from "@/ui/Button";
import { ConfirmButton } from "@/ui/ConfirmButton";
import { OrchestratorFace } from "@/ui/Face";
import { Field, TextArea, TextInput } from "@/ui/Field";

import { FromTemplate } from "./FromTemplate";

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
    look: { build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "", orchestrator: "foreman" },
  };
}

export function OrchestratorProfile(props: { saved?: Agent | undefined; start: Agent; all: readonly Agent[] }) {
  const isNew = untrack(() => !props.saved);
  const [draft, setDraft] = createSignal(untrack(() => props.start));
  const saving = createAct();
  const act = createAct();
  const router = useRouter();
  const client = useQueryClient();
  const dirty = () => isNew || !same(props.saved, draft());
  const nameTaken = () => props.all.some((a) => a.id !== draft().id && a.name === draft().name.trim());
  const patch = (p: Partial<Agent>) => setDraft({ ...draft(), ...p });
  const setLook = (orchestrator: OrchestratorLook) => patch({ look: { ...draft().look, orchestrator } });

  const save = () => {
    const d = draft();
    const body = { ...d, name: d.name.trim() || t("web.agent.orchestrator.newName") };
    return saving.run(async () => {
      const got = isNew ? await api.agent.create(body) : await api.agent.update(body);
      await client.invalidateQueries({ queryKey: ["agents"] });
      setDraft(got);
      if (isNew) router.navigate(`/agents/${encodeURIComponent(got.id)}`);
    });
  };
  const remove = () => {
    const id = draft().id;
    return act.run(async () => {
      await api.agent.delete({ id });
      await client.invalidateQueries({ queryKey: ["agents"] });
      router.navigate("/agents");
    });
  };
  const talk = () => {
    const agent = draft().id;
    void act.run(async () => router.navigate(`/chat/${await api.channel.direct.create({ agent })}`));
  };

  return (
    <div class="h-full overflow-y-auto px-4 pb-8">
      <div class="mx-auto flex max-w-3xl flex-col gap-4">
        <div
          data-testid="profile-bar"
          data-state={isNew ? "new" : dirty() ? "dirty" : "saved"}
          class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-3"
        >
          <A href="/agents" data-testid="back" class="text-sm text-muted hover:underline">
            {t("web.agent.all")}
          </A>
          <span class="text-sm text-faint">/</span>
          <span class="flex min-w-0 flex-1 items-center gap-3">
            <span class="truncate text-lg font-semibold">{draft().name || t("web.agent.unnamed")}</span>
            <span class="shrink-0 rounded bg-hover px-1.5 text-xs text-muted">{t("web.agent.role.orchestrator")}</span>
            <span class={["shrink-0 rounded px-1.5 text-xs", dirty() ? "bg-hat text-bark-900" : "bg-hover text-muted"]}>
              {isNew ? t("web.agent.isNew") : dirty() ? t("web.agent.unsaved") : t("web.agent.saved")}
            </span>
          </span>
          <span class="flex flex-wrap items-center gap-2">
            <Show when={props.saved}>
              {(saved) => (
                <>
                  <Show when={saved().id !== defaultOrchestrator}>
                    <ConfirmButton
                      label={t("web.agent.remove")}
                      question={t("web.agent.removeWhich", { name: saved().name })}
                      testid="delete"
                      onConfirm={remove}
                    />
                  </Show>
                  <Button icon="thread" data-testid="talk" disabled={act.busy()} onClick={talk}>
                    {t("web.agent.talk")}
                  </Button>
                  <Show when={dirty()}>
                    <Button data-testid="discard" onClick={() => setDraft(saved())}>
                      {t("web.agent.discard")}
                    </Button>
                  </Show>
                </>
              )}
            </Show>
            <Button tone="primary" data-testid="save" disabled={!dirty() || saving.busy() || nameTaken()} onClick={() => void save()}>
              {saving.busy() ? t("web.agent.saving") : isNew ? t("web.agent.create") : t("web.agent.save")}
            </Button>
          </span>
        </div>
        <Show when={props.saved}>{(saved) => <FromTemplate agent={saved()} onUpdated={setDraft} />}</Show>
        <p class="text-sm text-muted">
          {t("web.agent.orchestrator.intro")}{" "}
          <Show when={props.saved}>
            {(saved) => (
              <A href={orchestratorHref(saved().id)} class="underline">
                {t("web.agent.orchestrator.page")}
              </A>
            )}
          </Show>
        </p>
        <div class="grid gap-4 sm:grid-cols-2">
          <Field label={t("web.agent.name")} hint={nameTaken() ? t("web.agent.nameTaken") : t("web.agent.orchestrator.nameTip")}>
            <TextInput data-testid="agent-name" aria-label={t("web.agent.name")} value={draft().name} onInput={(e) => patch({ name: e.currentTarget.value })} />
          </Field>
          <Field label={t("web.agent.orchestrator.model")} hint={t("web.agent.orchestrator.modelTip")}>
            <TextInput
              aria-label={t("web.agent.orchestrator.model")}
              value={draft().model}
              placeholder={t("web.agent.orchestrator.modelHint")}
              onInput={(e) => patch({ model: e.currentTarget.value })}
            />
          </Field>
        </div>
        <Field label={t("web.agent.duty")} hint={t("web.agent.orchestrator.dutyTip")}>
          <TextInput data-testid="agent-duty" aria-label={t("web.agent.duty")} value={draft().duty} onInput={(e) => patch({ duty: e.currentTarget.value })} />
        </Field>
        <Field label={t("web.agent.personaLabel")} hint={t("web.agent.orchestrator.personaTip")}>
          <TextArea
            rows={5}
            aria-label={t("web.agent.personaLabel")}
            value={draft().persona}
            placeholder={t("web.agent.orchestrator.personaHint")}
            onInput={(e) => patch({ persona: e.currentTarget.value })}
          />
        </Field>
        <div class="flex flex-col gap-2">
          <span class="text-xs font-medium text-muted">{t("web.agent.orchestrator.look")}</span>
          <RadioGroup
            aria-label={t("web.agent.orchestrator.look")}
            value={draft().look.orchestrator ?? "farmer"}
            onValueChange={(v) => {
              const look = OrchestratorLookValues.find((l) => l === v);
              if (look) setLook(look);
            }}
            class="grid grid-cols-3 gap-2 sm:grid-cols-6"
          >
            <For each={orchestratorLooks}>
              {(look) => (
                <Radio.Root
                  value={look.id}
                  data-key={look.id}
                  title={look.blurb}
                  class="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-line p-2 text-xs hover:bg-hover data-checked:border-leaf data-checked:bg-selected"
                >
                  <OrchestratorFace size={48} look={look.id} />
                  {look.name}
                </Radio.Root>
              )}
            </For>
          </RadioGroup>
        </div>
      </div>
    </div>
  );
}
