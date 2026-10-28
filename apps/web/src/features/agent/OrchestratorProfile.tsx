// An orchestrator's profile, made or edited: its name, what it does, its persona, its DeepSeek model and its look. It
// runs on VibeValley's own agent only, so it has no machine to pick; its memory and rounds are on its orchestrator page.

import { agentsWording } from "./words";
import { createSignal, For, Show, untrack } from "solid-js";
import { useQueryClient } from "@tanstack/solid-query";
import { type Agent, defaultOrchestrator, orchestratorRuntime, type OrchestratorLook } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import { api, reasonOf } from "../../base/api";
import { useRouter } from "../../base/router";
import { aria } from "../../base/util";
import { toast } from "../../ui/toasts";
import { A } from "../../ui/A";
import { Button } from "../../ui/Button";
import { OrchestratorFace } from "../../ui/Face";
import { Field, TextArea, TextInput } from "../../ui/Field";
import { orchestratorHref, orchestratorLooks } from "../orchestrator";
import { FromTemplate } from "./FromTemplate";

export function newOrchestrator(): Agent {
  return {
    id: "",
    name: agentsWording().orchestrator.newName,
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

export function OrchestratorProfile(props: { saved?: Agent; start: Agent; all: readonly Agent[] }) {
  const isNew = untrack(() => !props.saved);
  const [draft, setDraft] = createSignal(untrack(() => props.start));
  const [saving, setSaving] = createSignal(false);
  const [sure, setSure] = createSignal(false);
  const router = useRouter();
  const client = useQueryClient();
  const dirty = () => isNew || !same(props.saved, draft());
  const nameTaken = () => props.all.some((a) => a.id !== draft().id && a.name === draft().name.trim());
  const patch = (p: Partial<Agent>) => setDraft({ ...draft(), ...p });
  const setLook = (orchestrator: OrchestratorLook) => patch({ look: { ...draft().look, orchestrator } });

  const save = async () => {
    setSaving(true);
    const d = draft();
    const body = { ...d, name: d.name.trim() || agentsWording().orchestrator.newName };
    try {
      const got = isNew ? await api.agent.create(body) : await api.agent.update(body);
      await client.invalidateQueries({ queryKey: ["agents"] });
      setDraft(got);
      if (isNew) router.navigate(`/agents/${encodeURIComponent(got.id)}`);
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    try {
      await api.agent.delete({ id: draft().id });
      await client.invalidateQueries({ queryKey: ["agents"] });
      router.navigate("/agents");
    } catch (e) {
      toast(reasonOf(e));
    }
  };
  const talk = () =>
    void api.channel.direct
      .create({ agent: draft().id })
      .then((id) => router.navigate(`/chat/${id}`))
      .catch((e) => toast(reasonOf(e), "bad"));

  return (
    <div class="h-full overflow-y-auto px-4 pb-8">
      <div class="mx-auto flex max-w-3xl flex-col gap-4">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-3">
          <A href="/agents" class="text-sm text-muted hover:underline">
            {agentsWording().all}
          </A>
          <span class="text-sm text-faint">/</span>
          <span class="flex min-w-0 flex-1 items-center gap-3">
            <span class="truncate text-lg font-semibold">{draft().name || agentsWording().unnamed}</span>
            <span class="shrink-0 rounded bg-hover px-1.5 text-xs text-muted">{agentsWording().role.orchestrator}</span>
            <span class={["shrink-0 rounded px-1.5 text-xs", dirty() ? "bg-hat text-bark-900" : "bg-hover text-muted"]}>
              {isNew ? agentsWording().isNew : dirty() ? agentsWording().unsaved : agentsWording().saved}
            </span>
          </span>
          <span class="flex flex-wrap items-center gap-2">
            <Show when={props.saved}>
              {(saved) => (
                <>
                  <Show when={saved().id !== defaultOrchestrator}>
                    <Show when={sure()} fallback={<Button onClick={() => setSure(true)}>{agentsWording().remove}</Button>}>
                      <span class="flex items-center gap-2">
                        <span class="text-sm text-muted">{agentsWording().removeWhich(saved().name)}</span>
                        <Button tone="danger" onClick={() => void remove()}>
                          {agentsWording().remove}
                        </Button>
                        <Button onClick={() => setSure(false)}>{agentsWording().never}</Button>
                      </span>
                    </Show>
                  </Show>
                  <Button icon="thread" onClick={talk}>
                    {agentsWording().talk}
                  </Button>
                  <Show when={dirty()}>
                    <Button onClick={() => setDraft(saved())}>{agentsWording().discard}</Button>
                  </Show>
                </>
              )}
            </Show>
            <Button tone="primary" disabled={!dirty() || saving() || nameTaken()} onClick={() => void save()}>
              {saving() ? agentsWording().saving : isNew ? agentsWording().create : agentsWording().save}
            </Button>
          </span>
        </div>
        <Show when={props.saved}>{(saved) => <FromTemplate agent={saved()} onUpdated={setDraft} />}</Show>
        <p class="text-sm text-muted">
          {agentsWording().orchestrator.intro}{" "}
          <Show when={props.saved}>
            {(saved) => (
              <A href={orchestratorHref(saved().id)} class="underline">
                {agentsWording().orchestrator.page}
              </A>
            )}
          </Show>
        </p>
        <div class="grid gap-4 sm:grid-cols-2">
          <Field label={agentsWording().name} hint={nameTaken() ? agentsWording().nameTaken : agentsWording().orchestrator.nameTip}>
            <TextInput aria-label={agentsWording().name} value={draft().name} onInput={(e) => patch({ name: e.currentTarget.value })} />
          </Field>
          <Field label={agentsWording().orchestrator.model} hint={agentsWording().orchestrator.modelTip}>
            <TextInput
              aria-label={agentsWording().orchestrator.model}
              value={draft().model}
              placeholder={agentsWording().orchestrator.modelHint}
              onInput={(e) => patch({ model: e.currentTarget.value })}
            />
          </Field>
        </div>
        <Field label={agentsWording().duty} hint={agentsWording().orchestrator.dutyTip}>
          <TextInput aria-label={agentsWording().duty} value={draft().duty} onInput={(e) => patch({ duty: e.currentTarget.value })} />
        </Field>
        <Field label={agentsWording().personaLabel} hint={agentsWording().orchestrator.personaTip}>
          <TextArea
            rows={5}
            aria-label={agentsWording().personaLabel}
            value={draft().persona}
            placeholder={agentsWording().orchestrator.personaHint}
            onInput={(e) => patch({ persona: e.currentTarget.value })}
          />
        </Field>
        <div class="flex flex-col gap-2">
          <span class="text-xs font-medium text-muted">{agentsWording().orchestrator.look}</span>
          <div role="radiogroup" aria-label={agentsWording().orchestrator.look} class="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <For each={orchestratorLooks}>
              {(look) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={aria((draft().look.orchestrator ?? "farmer") === look.id)}
                  title={look.blurb}
                  onClick={() => setLook(look.id)}
                  class={[
                    "flex cursor-pointer flex-col items-center gap-1 rounded-lg border p-2 text-xs",
                    (draft().look.orchestrator ?? "farmer") === look.id ? "border-leaf bg-selected" : "border-line hover:bg-hover",
                  ]}
                >
                  <OrchestratorFace size={48} look={look.id} />
                  {look.name}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}
