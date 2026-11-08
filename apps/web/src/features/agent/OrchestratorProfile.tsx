import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show, untrack } from "solid-js";

import { Radio, RadioGroup } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";
import { type Agent, defaultOrchestrator, orchestratorRuntime, type OrchestratorLook, OrchestratorLookValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { orchestratorHref, orchestratorLooks } from "#/features/orchestrator/index.ts";
import { api } from "#/infra/api.ts";
import { useQueryClient } from "#/infra/query.ts";
import { useRouter, Link as A } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { OrchestratorFace } from "#/ui/Face.tsx";
import { Field, TextArea, TextInput } from "#/ui/Field.tsx";

import { FromTemplate } from "./FromTemplate";

const viewStyles = stylex.create({
  orchestratorProfileDiv: {
    height: "100%",
    overflowY: "auto",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBottom: "calc(var(--spacing) * 8)",
  },
  orchestratorProfileDiv2: {
    display: "flex",
    maxWidth: "var(--container-3xl)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
  },
  profileBar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "calc(var(--spacing) * 3)",
    rowGap: "calc(var(--spacing) * 2)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--wb-line)",
    paddingBlock: "calc(var(--spacing) * 3)",
  },
  orchestratorProfileSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-faint)",
  },
  orchestratorProfileSpan2: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
  },
  orchestratorProfileSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--text-lg--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  orchestratorProfileSpan4: {
    flexShrink: "0",
    borderRadius: ".25rem",
    backgroundColor: "var(--wb-hover)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  orchestratorProfileSpan5: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  orchestratorProfileP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  orchestratorProfileDiv3: {
    display: "grid",
    gap: "calc(var(--spacing) * 4)",
    gridTemplateColumns: {
      default: null,
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
    },
  },
  orchestratorProfileDiv4: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  orchestratorProfileSpan6: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--wb-muted)",
  },
});

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
      await client.invalidate({ prefix: ["agents"] });
      setDraft(got);
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
    <div {...stylex.attrs(viewStyles.orchestratorProfileDiv)}>
      <div {...stylex.attrs(viewStyles.orchestratorProfileDiv2)}>
        <div data-testid="profile-bar" data-state={isNew ? "new" : dirty() ? "dirty" : "saved"} {...stylex.attrs(viewStyles.profileBar)}>
          <A href="/agents" data-testid="back" class="text-sm text-muted hover:underline">
            {t("web.agent.all")}
          </A>
          <span {...stylex.attrs(viewStyles.orchestratorProfileSpan)}>/</span>
          <span {...stylex.attrs(viewStyles.orchestratorProfileSpan2)}>
            <span {...stylex.attrs(viewStyles.orchestratorProfileSpan3)}>{draft().name || t("web.agent.unnamed")}</span>
            <span {...stylex.attrs(viewStyles.orchestratorProfileSpan4)}>{t("web.agent.role.orchestrator")}</span>
            <span class={["shrink-0 rounded px-1.5 text-xs", dirty() ? "bg-hat text-bark-900" : "bg-hover text-muted"]}>
              {isNew ? t("web.agent.isNew") : dirty() ? t("web.agent.unsaved") : t("web.agent.saved")}
            </span>
          </span>
          <span {...stylex.attrs(viewStyles.orchestratorProfileSpan5)}>
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
        <p {...stylex.attrs(viewStyles.orchestratorProfileP)}>
          {t("web.agent.orchestrator.intro")}{" "}
          <Show when={props.saved}>
            {(saved) => (
              <A href={orchestratorHref(saved().id)} class="underline">
                {t("web.agent.orchestrator.page")}
              </A>
            )}
          </Show>
        </p>
        <div {...stylex.attrs(viewStyles.orchestratorProfileDiv3)}>
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
        <div {...stylex.attrs(viewStyles.orchestratorProfileDiv4)}>
          <span {...stylex.attrs(viewStyles.orchestratorProfileSpan6)}>{t("web.agent.orchestrator.look")}</span>
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
