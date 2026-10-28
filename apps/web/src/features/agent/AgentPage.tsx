import { t } from "@vibevalley/i18n";
// One profile, made or edited: its
// look on the left, the helper on its bed in the middle, what it is and runs on in tabs on the right; what would keep the
// orchestrator from sending it, the server's answer (agent.check), under them.

import { agentsWording } from "./words";
import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useQueryClient } from "@tanstack/solid-query";
import {
  type Agent,
  type AgentProblem,
  type InventoryEntry,
  type MCPServer,
  OutfitValues,
  type PersonaMode,
  type RuntimeFacts,
  type RuntimeInfo,
  sessionAppendSystemPrompt,
  sessionDisallowedTools,
  sessionEffort,
  sessionEnv,
  sessionMcpServers,
  sessionSystemPrompt,
  SpeciesValues,
} from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import { api, reasonOf } from "../../base/api";
import { castOf, castPrefix, cropSprite, outfitLabel, type Pose, randomLook, speciesLabel, stagePoses } from "../../ui/cast";
import { runtimeName } from "../../ui/runtimes";
import { toast } from "../../ui/toasts";
import { A } from "../../ui/A";
import { useRouter, useSearch } from "../../base/router";
import { aria } from "../../base/util";
import { useAgentProblems } from "../../base/agents";
import { ready, useAgents, useRuntimes, useSprites } from "../../base/query";
import { RuntimeIcon } from "../../ui/pixel/RuntimeIcon";
import { Button } from "../../ui/Button";
import { ChipsInput, KeyValueEditor } from "../../ui/Chips";
import { AgentFace } from "../../ui/Face";
import { Select, TextArea, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { PoseSprite } from "../../ui/PoseSprite";
import { Segmented } from "../../ui/Segmented";
import { Toggle } from "../../ui/layout";
import { MemoryPanel } from "../memory";
import { useSkills } from "../runtime";
import { TrajectoryList } from "../session";
import { newOrchestrator, OrchestratorProfile } from "./OrchestratorProfile";
import { FromTemplate } from "./FromTemplate";
import { Hint } from "../../ui/Tip";

const unknownFacts: RuntimeFacts = { steer: false, refused: {}, capabilities: [], inProcess: false };
const factsOf = (info: RuntimeInfo | undefined) => info?.facts ?? unknownFacts;

export function newAgent(runtime: string, catalog: readonly RuntimeInfo[]): Agent {
  const info = catalog.find((r) => r.id === runtime);
  return {
    id: "",
    name: t("web.agent.newName", { runtime: runtimeName(catalog, runtime) }),
    role: "worker",
    duty: "",
    enabled: true,
    runtime,
    model: "",
    effort: "",
    persona: "",
    personaMode: factsOf(info).refused[sessionAppendSystemPrompt] ? "prompt" : "append",
    skills: [],
    mcpServers: [],
    disallowedTools: [],
    env: {},
    workdir: "",
    worktree: true,
    tags: [],
    look: { ...randomLook(), outfit: "farmer" },
  };
}

type Patch = (a: Agent) => void;

/** Built again for each id (Keyed by the route). */
export function AgentPage(props: { id: string }) {
  const isNew = () => props.id === "new";
  const search = useSearch();
  const agents = useAgents();
  const runtimes = useRuntimes();
  const loaded = () => ready(agents, undefined);
  const saved = () => loaded()?.find((a) => a.id === props.id);
  return (
    <Switch>
      <Match when={agents.error}>
        {(e) => (
          <p class="p-8 text-sm text-muted">
            {t("web.agent.noProfiles")}
            {reasonOf(e())}
          </p>
        )}
      </Match>
      <Match when={!loaded() || (isNew() && !ready(runtimes, undefined))}>
        <p class="p-8 text-sm text-muted">
          {isNew() && runtimes.error ? t("web.agent.noRuntimes", { why: reasonOf(runtimes.error) }) : t("web.agent.loading")}
        </p>
      </Match>
      <Match when={!isNew() && !saved()}>
        <p class="p-8 text-sm text-muted">
          {t("web.agent.noSuch")}
          <A href="/agents" class="underline">
            {t("web.agent.backToAll")}
          </A>
        </p>
      </Match>
      <Match when={(saved()?.role ?? (search().get("role") === "orchestrator" ? "orchestrator" : "worker")) === "orchestrator" && loaded()}>
        {(all) => <OrchestratorProfile saved={saved()} start={untrack(() => saved() ?? newOrchestrator())} all={all()} />}
      </Match>
      <Match when={loaded()}>
        {(all) => <Creator saved={saved()} start={untrack(() => saved() ?? newAgent(search().get("runtime") ?? "claude", ready(runtimes, [])))} all={all()} />}
      </Match>
    </Switch>
  );
}

function Creator(props: { saved?: Agent; start: Agent; all: readonly Agent[] }) {
  // A new one stays new until it is saved and the route moves to its id, which builds the page again.
  const isNew = untrack(() => !props.saved);
  const [draft, setDraft] = createSignal(untrack(() => props.start));
  const [pose, setPose] = createSignal<Pose>("idle");
  const [saving, setSaving] = createSignal(false);
  const [trajectories, setTrajectories] = createSignal(false);
  const router = useRouter();
  const client = useQueryClient();
  const runtimes = useRuntimes();
  const runtime = () => ready(runtimes, []).find((r) => r.id === draft().runtime);
  const allProblems = useAgentProblems(() => [draft()]);
  const problems = () => allProblems()[draft().id] ?? [];
  const dirty = () => isNew || !same(props.saved, draft());
  const nameTaken = () => props.all.some((a) => a.id !== draft().id && a.name === draft().name.trim());

  const save = async () => {
    setSaving(true);
    const d = draft();
    const body = { ...d, name: d.name.trim() || t("web.agent.unnamedAgent") };
    try {
      const got = isNew ? await api.agent.create(body) : await api.agent.update(body);
      client.setQueryData<Agent[]>(["agents"], (list) => (list ? [...list.filter((a) => a.id !== got.id), got] : list));
      await client.invalidateQueries({ queryKey: ["agents"] });
      setDraft(got);
      if (isNew) router.navigate(`/agents/${encodeURIComponent(got.id)}`);
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setSaving(false);
    }
  };

  const bar = () => (
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-3">
      <A href="/agents" class="text-sm text-muted hover:underline">
        {t("web.agent.all")}
      </A>
      <span class="text-sm text-faint">/</span>
      <span class="flex min-w-0 flex-1 items-center gap-3">
        <span class="truncate text-lg font-semibold">{draft().name || t("web.agent.unnamed")}</span>
        <span class={["shrink-0 rounded px-1.5 text-xs", isNew || dirty() ? "bg-hat text-bark-900" : "bg-hover text-muted"]}>
          {isNew ? t("web.agent.isNew") : dirty() ? t("web.agent.unsaved") : t("web.agent.saved")}
        </span>
      </span>
      <span class="flex flex-wrap items-center gap-2">
        <Show when={props.saved}>
          {(saved) => (
            <>
              <DeleteButton agent={saved()} />
              <Button
                icon="thread"
                onClick={() =>
                  void api.channel.direct
                    .create({ agent: saved().id })
                    .then((id) => router.navigate(`/chat/${id}`))
                    .catch((e) => toast(reasonOf(e), "bad"))
                }
              >
                {t("web.agent.talk")}
              </Button>
              <Show when={dirty()}>
                <Button onClick={() => setDraft(saved())}>{t("web.agent.discard")}</Button>
              </Show>
            </>
          )}
        </Show>
        <Button tone="primary" disabled={!dirty() || saving() || nameTaken()} onClick={() => void save()}>
          {saving() ? t("web.agent.saving") : isNew ? t("web.agent.create") : t("web.agent.save")}
        </Button>
      </span>
    </div>
  );

  return (
    <Show
      when={!trajectories()}
      fallback={
        <div class="flex h-full min-h-0 flex-col gap-3 px-4 pb-4">
          {bar()}
          <div class="flex items-center gap-3">
            <button type="button" class="cursor-pointer text-sm text-muted hover:underline" onClick={() => setTrajectories(false)}>
              {t("web.agent.backToProfile")}
            </button>
            <span class="text-sm font-semibold" title={t("web.agent.trajectoriesHint")}>
              {t("web.agent.trajectories")}
            </span>
          </div>
          <div class="min-h-0 flex-1">
            <TrajectoryList agent={draft().id} />
          </div>
        </div>
      }
    >
      <div class="flex h-full min-h-0 flex-col px-4 pb-4">
        {bar()}
        <Show when={props.saved}>{(saved) => <FromTemplate agent={saved()} onUpdated={setDraft} />}</Show>
        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pt-3 lg:flex-row lg:overflow-hidden">
          <div class="shrink-0 rounded-lg border border-line bg-page p-4 lg:w-76 lg:overflow-y-auto">
            <LookPanel draft={draft()} onChange={(look) => setDraft({ ...draft(), look })} />
          </div>
          <div class="flex min-h-104 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-page">
            <Stage draft={draft()} pose={pose()} />
            <div class="flex flex-wrap justify-center gap-1.5 p-3">
              <For each={stagePoses}>
                {(p) => (
                  <button
                    type="button"
                    aria-pressed={aria(pose() === p.pose)}
                    onClick={() => setPose(p.pose)}
                    class={["h-6 cursor-pointer rounded-full px-2.5 text-xs", pose() === p.pose ? "bg-ink text-page" : "bg-hover hover:bg-selected"]}
                  >
                    {p.label}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="flex shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-page lg:w-108">
            <ConfigTabs
              draft={draft()}
              runtime={runtime()}
              patch={setDraft}
              nameTaken={nameTaken()}
              isNew={isNew}
              onTrajectories={() => setTrajectories(true)}
            />
            <Problems problems={problems()} />
          </div>
        </div>
      </div>
    </Show>
  );
}

function DeleteButton(props: { agent: Agent }) {
  const [sure, setSure] = createSignal(false);
  const router = useRouter();
  const client = useQueryClient();
  const remove = async () => {
    const id = props.agent.id;
    try {
      await api.agent.delete({ id });
      await client.invalidateQueries({ queryKey: ["agents"] });
      router.navigate("/agents");
    } catch (e) {
      toast(reasonOf(e));
    }
  };
  return (
    <Show when={sure()} fallback={<Button onClick={() => setSure(true)}>{t("web.agent.remove")}</Button>}>
      <span class="flex items-center gap-2">
        <span class="text-sm text-muted">{t("web.agent.removeWhich", { name: props.agent.name })}</span>
        <Button tone="danger" onClick={() => void remove()}>
          {t("web.agent.remove")}
        </Button>
        <Button onClick={() => setSure(false)}>{t("web.agent.never")}</Button>
      </span>
    </Show>
  );
}

function Problems(props: { problems: AgentProblem[] }) {
  return (
    <Show
      when={props.problems.length > 0}
      fallback={
        <p class="flex items-center gap-1.5 border-t border-line px-4 py-3 text-sm text-[#3f6427]">
          <Icon name="check" size={12} />
          {t("web.agent.fine")}
        </p>
      }
    >
      <ul aria-label={t("web.agent.problems")} class="flex max-h-40 flex-col gap-1 overflow-y-auto border-t border-line px-4 py-3">
        <For each={props.problems}>
          {(i) => (
            <li class={["flex items-start gap-1.5 text-sm", i.level === "error" ? "text-berry" : "text-[#b8682a]"]}>
              <Icon name={i.level === "error" ? "cross" : "warn"} size={12} class="mt-1" />
              {i.level === "error" ? t("web.agent.cannot") : ""}
              {i.text}
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function LookPanel(props: { draft: Agent; onChange: (look: Agent["look"]) => void }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  const sprites = useSprites();
  return (
    <div class="flex flex-col gap-5">
      <div>
        <Button icon="shuffle" onClick={() => props.onChange(randomLook())}>
          {t("web.agent.random")}
        </Button>
      </div>
      <Labeled label={t("web.agent.looksAs")} hint={t("web.agent.looksHint")}>
        <div class="grid grid-cols-4 gap-1.5">
          <For each={SpeciesValues}>
            {(species) => (
              <Tile active={cast().species === species} label={speciesLabel[species]} onClick={() => props.onChange({ ...props.draft.look, species })}>
                <AgentFace agentId={props.draft.id} runtime={props.draft.runtime} look={{ ...props.draft.look, species, outfit: cast().outfit }} size={48} />
              </Tile>
            )}
          </For>
        </div>
      </Labeled>
      <Labeled label={t("web.agent.wears")}>
        <div class="grid grid-cols-4 gap-1.5">
          <For each={OutfitValues}>
            {(outfit) => {
              const name = () => {
                const s = ready(sprites, undefined);
                return s ? `${castPrefix({ ...props.draft.look, species: cast().species, outfit }, props.draft.id, (n) => n in s)}-down` : undefined;
              };
              return (
                <Tile active={cast().outfit === outfit} label={outfitLabel[outfit]} onClick={() => props.onChange({ ...props.draft.look, outfit })}>
                  <span class="flex h-16 items-center justify-center">
                    <Show when={name()}>{(n) => <img src={`/pixel/${n()}.png`} alt="" class="h-16 object-contain [image-rendering:pixelated]" />}</Show>
                  </span>
                </Tile>
              );
            }}
          </For>
        </div>
      </Labeled>
    </div>
  );
}

function Tile(props: { active: boolean; label: string; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={aria(props.active)}
      onClick={() => props.onClick()}
      class={[
        "flex cursor-pointer flex-col items-center gap-0.5 rounded-md border px-1 pt-1 pb-1.5",
        props.active ? "border-ink/40 bg-selected" : "border-line hover:bg-hover",
      ]}
    >
      {props.children}
      <span class={["text-xs", props.active ? "font-semibold" : "text-muted"]}>{props.label}</span>
    </button>
  );
}

/** The helper on the bed its pose goes with, its name under it. */
function Stage(props: { draft: Agent; pose: Pose }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  const crop = () => stagePoses.find((p) => p.pose === props.pose)!.crop;
  return (
    <div
      class="relative flex flex-1 items-center justify-center overflow-hidden"
      style={{ background: "radial-gradient(60% 60% at 50% 45%, #c7dd9a, #9cc069 60%, #7ea64f)" }}
    >
      <div class="relative h-72 w-96 max-w-full">
        <img
          src={`/pixel/${cropSprite(crop())}.png`}
          alt=""
          class="absolute bottom-6 w-72 [image-rendering:pixelated]"
          style={{ left: `${192 - 288 * 0.62}px` }}
          onError={(e) => (e.currentTarget.style.display = "none")}
        />
        <div class="absolute right-24 bottom-2 translate-x-1/2">
          <PoseSprite cast={cast()} pose={props.pose} height={224} />
        </div>
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-4 flex flex-col items-center gap-1">
        <span class="rounded-md bg-paper/92 px-3 py-0.5 text-lg">{props.draft.name || t("web.agent.unnamedAgent")}</span>
        <Show when={props.draft.duty}>
          <span class="max-w-96 rounded bg-paper/75 px-2 py-px text-center text-xs">{props.draft.duty}</span>
        </Show>
      </div>
      <span class="pointer-events-none absolute top-3 right-4 rounded bg-paper/75 px-2 py-px text-xs">
        {speciesLabel[cast().species]} · {outfitLabel[cast().outfit]}
      </span>
    </div>
  );
}

type Tab = "who" | "runtime" | "persona" | "skills" | "tools" | "env" | "memory" | "trajectories";

function ConfigTabs(props: { draft: Agent; runtime?: RuntimeInfo; patch: Patch; nameTaken: boolean; isNew: boolean; onTrajectories: () => void }) {
  const [tab, setTab] = createSignal<Tab>("who");
  const facts = () => factsOf(props.runtime);
  const tabs = (): [Tab, string][] => [
    ["who", t("web.agent.tab.who")],
    ["runtime", t("web.agent.tab.runtime")],
    ["persona", t("web.agent.tab.persona")],
    ["skills", t("web.agent.tab.skills")],
    ["tools", t("web.agent.tab.tools")],
    ["env", t("web.agent.tab.env")],
    ...(props.isNew
      ? []
      : ([
          ["memory", t("web.agent.tab.memory")],
          ["trajectories", t("web.agent.trajectories")],
        ] as [Tab, string][])),
  ];
  const envRefused = () => facts().refused[sessionEnv];
  const draft = () => props.draft;
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label={t("web.agent.tabs")} class="flex flex-wrap gap-0.5 border-b border-line px-3 py-2">
        <For each={tabs()}>
          {([t, label]) => (
            <button
              type="button"
              role="tab"
              aria-selected={aria(t === tab())}
              onClick={() => (t === "trajectories" ? props.onTrajectories() : setTab(t))}
              class={["h-7 cursor-pointer rounded-md px-2.5 text-sm", t === tab() ? "bg-selected font-semibold" : "text-muted hover:bg-hover hover:text-ink"]}
            >
              {label}
            </button>
          )}
        </For>
      </div>
      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <Switch>
          <Match when={tab() === "who"}>
            <Labeled label={t("web.agent.name")} tip={t("web.agent.nameTip")} error={props.nameTaken ? t("web.agent.nameTaken") : undefined}>
              <TextInput aria-label={t("web.agent.name")} value={draft().name} onInput={(e) => props.patch({ ...draft(), name: e.currentTarget.value })} />
            </Labeled>
            <Labeled label={t("web.agent.duty")} tip={t("web.agent.dutyTip")}>
              <TextInput
                aria-label={t("web.agent.duty")}
                placeholder={t("web.agent.roleHint")}
                value={draft().duty}
                onInput={(e) => props.patch({ ...draft(), duty: e.currentTarget.value })}
              />
            </Labeled>
            <Labeled label={t("web.agent.tags")} tip={t("web.agent.tagsTip")}>
              <ChipsInput
                label={t("web.agent.tags")}
                placeholder={t("web.agent.tagsHint")}
                value={draft().tags}
                onChange={(tags) => props.patch({ ...draft(), tags })}
              />
            </Labeled>
            <Toggle
              label={t("web.agent.enabled")}
              hint={t("web.agent.enabledHint")}
              checked={draft().enabled}
              onChange={(enabled) => props.patch({ ...draft(), enabled })}
            />
          </Match>
          <Match when={tab() === "runtime"}>
            <RuntimeChoice draft={draft()} patch={props.patch} />
            <ModelAndEffort draft={draft()} runtime={props.runtime} patch={props.patch} />
            <Facts runtime={draft().runtime} info={props.runtime} />
          </Match>
          <Match when={tab() === "persona"}>
            <Persona draft={draft()} facts={facts()} patch={props.patch} />
          </Match>
          <Match when={tab() === "skills"}>
            <SkillPicker draft={draft()} runtime={props.runtime} patch={props.patch} />
          </Match>
          <Match when={tab() === "tools"}>
            <Tools draft={draft()} runtime={props.runtime} patch={props.patch} />
          </Match>
          <Match when={tab() === "env"}>
            <Labeled label={t("web.agent.workdir")} tip={t("web.agent.workdirTip")}>
              <TextInput
                aria-label={t("web.agent.workdir")}
                class="font-mono"
                placeholder={t("web.agent.workdirHint")}
                value={draft().workdir}
                onInput={(e) => props.patch({ ...draft(), workdir: e.currentTarget.value })}
              />
            </Labeled>
            <Toggle
              label={t("web.agent.worktree")}
              hint={t("web.agent.worktreeHint")}
              checked={draft().worktree}
              onChange={(worktree) => props.patch({ ...draft(), worktree })}
            />
            <Labeled
              label={t("web.agent.env")}
              hint={envRefused() ?? t("web.agent.envHint")}
              error={envRefused() && Object.keys(draft().env).length > 0 ? envRefused() : undefined}
            >
              <KeyValueEditor value={draft().env} disabled={!!envRefused()} onChange={(env) => props.patch({ ...draft(), env })} />
            </Labeled>
          </Match>
          <Match when={tab() === "memory"}>
            <MemoryPanel agent={draft().id} />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

/** A label with what it means behind an info icon, what sits at its right, the control, and what is wrong under it. */
function Labeled(props: { label: string; tip?: string; hint?: string; error?: string; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-1.5">
        <span class="text-xs font-medium text-muted">{props.label}</span>
        <Show when={props.hint ?? props.tip}>{(h) => <Hint text={h()} />}</Show>
        <span class="flex-1" />
        {props.aside}
      </div>
      {props.children}
      <Show when={props.error}>
        <span class="text-xs text-berry">{props.error}</span>
      </Show>
    </div>
  );
}

function RuntimeChoice(props: { draft: Agent; patch: Patch }) {
  const all = useRuntimes();
  const runtimes = () => ready(all, []);
  const choose = (info: RuntimeInfo) => {
    const f = factsOf(info);
    const cannotTakeSystemPrompt = !!f.refused[sessionAppendSystemPrompt] || !!f.refused[sessionSystemPrompt];
    const d = props.draft;
    // A persona the new runtime can't take as a system prompt goes into each job instead.
    props.patch({
      ...d,
      runtime: info.id,
      model: "",
      effort: "",
      personaMode: d.personaMode !== "prompt" && cannotTakeSystemPrompt ? "prompt" : d.personaMode,
    });
  };
  return (
    <Labeled label={t("web.agent.machine")} tip={t("web.agent.machineTip")}>
      <Show when={runtimes().length > 0} fallback={<span class="text-xs text-muted">{t("web.agent.readingMachines")}</span>}>
        <div class="grid gap-1.5 sm:grid-cols-2">
          <For each={runtimes()}>
            {(info) => {
              const available = () => info.installation.status === "available";
              const ok = () => available() && info.settings.enabled;
              const active = () => props.draft.runtime === info.id;
              const status = () => {
                const inst = info.installation;
                return inst.status === "available"
                  ? info.settings.enabled
                    ? (inst.version ?? t("web.agent.available"))
                    : t("web.agent.disabled")
                  : inst.status === "checking"
                    ? t("web.agent.checking")
                    : t("web.agent.notHere");
              };
              return (
                <button
                  type="button"
                  aria-pressed={aria(active())}
                  aria-label={info.preset.label}
                  onClick={() => choose(info)}
                  class={[
                    "flex cursor-pointer items-center gap-2 rounded-md border p-2 text-left",
                    active() ? "border-ink/40 bg-selected" : "border-line hover:bg-hover",
                  ]}
                >
                  <span class={{ "opacity-50 grayscale": !ok() }}>
                    <RuntimeIcon runtime={info.id} size={32} />
                  </span>
                  <span class="flex min-w-0 flex-col">
                    <span class={["truncate text-sm", active() ? "font-semibold" : "font-medium"]}>{info.preset.label}</span>
                    <span class={["truncate text-xs", ok() ? "text-muted" : "text-berry"]}>{status()}</span>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </Labeled>
  );
}

function ModelAndEffort(props: { draft: Agent; runtime?: RuntimeInfo; patch: Patch }) {
  const models = () => props.runtime?.models ?? [];
  const fallback = () => props.runtime?.settings.defaultModel || models().find((m) => m.isDefault)?.id || "";
  const model = () => models().find((m) => m.id === (props.draft.model || fallback()));
  const refusedEffort = () => factsOf(props.runtime).refused[sessionEffort];
  const levels = () => model()?.effortLevels ?? [];
  return (
    <>
      <Labeled label={t("web.agent.model")} hint={models().length === 0 ? t("web.agent.noModels") : undefined}>
        <Select
          label={t("web.agent.model")}
          value={props.draft.model}
          placeholder={agentsWording().runtimeDefault(fallback() ?? "")}
          options={models().map((m) => ({
            value: m.id,
            label: m.effortLevels.length > 0 ? t("web.agent.modelLevels", { name: m.name, n: m.effortLevels.length }) : m.name,
          }))}
          onChange={(m) => props.patch({ ...props.draft, model: m, effort: "" })}
        />
      </Labeled>
      <Labeled
        label={t("web.agent.effort")}
        hint={refusedEffort() ?? (levels().length === 0 ? agentsWording().noEffort(model()?.name) : t("web.agent.effortDefault"))}
      >
        <div>
          <Segmented
            label={t("web.agent.effort")}
            value={props.draft.effort}
            options={[{ value: "", label: t("web.agent.defaultEffort") }, ...levels().map((l) => ({ value: l, label: l, disabled: !!refusedEffort() }))]}
            onChange={(effort) => props.patch({ ...props.draft, effort })}
          />
        </div>
      </Labeled>
    </>
  );
}

/** What it takes comes with runtime.list: until then, nothing is said rather than a guess. */
function Facts(props: { runtime: string; info?: RuntimeInfo }) {
  const facts = () => factsOf(props.info);
  return (
    <section class="flex flex-col gap-1.5 rounded-lg border border-line p-3">
      <h3 class="text-sm font-semibold">{t("web.agent.can", { runtime: props.info ? props.info.preset.label : props.runtime })}</h3>
      <Show when={props.info} fallback={<span class="text-sm">{t("web.agent.readingMachines")}</span>}>
        <span class="flex items-start gap-1.5 text-sm">
          <Icon name={facts().steer ? "check" : "cross"} size={12} class="mt-1" />
          {facts().steer ? t("web.agent.steer") : t("web.agent.noSteer")}
        </span>
        <span class="text-sm">{facts().inProcess ? t("web.agent.inProcess") : t("web.agent.ownProcess")}</span>
        <For each={Object.entries(facts().refused)}>
          {([option, reason]) => (
            <span class="text-sm text-muted">
              {t("web.agent.refuses")}
              <span class="font-mono text-ink">{option}</span>
              {t("web.agent.colon")}
              {reason}
            </span>
          )}
        </For>
      </Show>
    </section>
  );
}

const personaModes: { value: PersonaMode; label: string; detail: string; option?: string }[] = [
  { value: "append", label: t("web.agent.persona.append.label"), detail: t("web.agent.persona.append.detail"), option: sessionAppendSystemPrompt },
  { value: "replace", label: t("web.agent.persona.replace.label"), detail: t("web.agent.persona.replace.detail"), option: sessionSystemPrompt },
  { value: "prompt", label: t("web.agent.persona.prompt.label"), detail: t("web.agent.persona.prompt.detail") },
];

function Persona(props: { draft: Agent; facts: RuntimeFacts; patch: Patch }) {
  const mode = () => personaModes.find((m) => m.value === props.draft.personaMode);
  return (
    <>
      <Labeled label={t("web.agent.tab.persona")} tip={t("web.agent.personaTip")}>
        <TextArea
          aria-label={t("web.agent.tab.persona")}
          rows={9}
          placeholder={t("web.agent.personaHint")}
          value={props.draft.persona}
          onInput={(e) => props.patch({ ...props.draft, persona: e.currentTarget.value })}
        />
      </Labeled>
      <Labeled label={t("web.agent.personaMode")} hint={mode()?.detail}>
        <div>
          <Segmented
            label={t("web.agent.personaMode")}
            value={props.draft.personaMode}
            options={personaModes.map((m) => ({
              value: m.value,
              label: m.label,
              disabled: !!m.option && !!props.facts.refused[m.option],
              title: m.option ? props.facts.refused[m.option] : undefined,
            }))}
            onChange={(personaMode) => props.patch({ ...props.draft, personaMode })}
          />
        </div>
      </Labeled>
    </>
  );
}

function SkillPicker(props: { draft: Agent; runtime?: RuntimeInfo; patch: Patch }) {
  const all = useSkills();
  const toggle = (id: string) => {
    const d = props.draft;
    props.patch({ ...d, skills: d.skills.includes(id) ? d.skills.filter((s) => s !== id) : [...d.skills, id] });
  };
  return (
    <>
      <Labeled
        label={t("web.agent.library")}
        tip={t("web.agent.libraryTip")}
        aside={
          <A href="/settings/skills" class="text-xs text-muted underline">
            {t("web.agent.manageLibrary")}
          </A>
        }
      >
        <div class="flex flex-col gap-1.5">
          <For each={ready(all, [])}>
            {(s) => {
              const on = () => props.draft.skills.includes(s.id);
              return (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={aria(on())}
                  aria-label={s.name}
                  onClick={() => toggle(s.id)}
                  class={[
                    "flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-left",
                    on() ? "border-ink/40 bg-selected" : "border-line hover:bg-hover",
                  ]}
                >
                  <span class={["mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border bg-page", on() ? "border-accent" : "border-ink/25"]}>
                    <Show when={on()}>
                      <Icon name="check" size={12} />
                    </Show>
                  </span>
                  <span class="flex flex-col">
                    <span class="text-sm font-medium">{s.name}</span>
                    <span class="text-xs text-muted">{s.description}</span>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </Labeled>
      <Labeled label={t("web.agent.ownSkills", { runtime: props.runtime?.preset.label ?? props.draft.runtime })} tip={t("web.agent.ownSkillsTip")}>
        <Inventory entries={props.runtime?.skills} />
      </Labeled>
    </>
  );
}

const mcpTarget = (s: MCPServer) => (s.type === "stdio" ? [s.command, ...s.args].join(" ") : s.url);

function Tools(props: { draft: Agent; runtime?: RuntimeInfo; patch: Patch }) {
  const facts = () => factsOf(props.runtime);
  const mcpRefused = () => facts().refused[sessionMcpServers];
  const toolsRefused = () => facts().refused[sessionDisallowedTools];
  const [type, setType] = createSignal<"stdio" | "http">("stdio");
  const [name, setName] = createSignal("");
  const [target, setTarget] = createSignal("");
  const add = () => {
    const n = name().trim();
    const wanted = target().trim();
    if (!n || !wanted) return;
    const words = wanted.split(/\s+/);
    const server: MCPServer =
      type() === "stdio" ? { type: "stdio", name: n, command: words[0]!, args: words.slice(1), env: {} } : { type: "http", name: n, url: wanted, headers: {} };
    props.patch({ ...props.draft, mcpServers: [...props.draft.mcpServers.filter((s) => s.name !== n), server] });
    setName("");
    setTarget("");
  };
  return (
    <>
      <Labeled
        label={t("web.agent.mcp")}
        hint={mcpRefused() ?? t("web.agent.mcpHint")}
        error={mcpRefused() && props.draft.mcpServers.length > 0 ? mcpRefused() : undefined}
      >
        <div class={["flex flex-col gap-1.5", { "opacity-50": !!mcpRefused() }]}>
          <For each={props.draft.mcpServers}>
            {(s) => (
              <div class="flex items-center gap-2 rounded-md border border-line px-3 py-2">
                <span class="rounded bg-selected px-1.5 text-xs">{s.type}</span>
                <span class="text-sm font-medium">{s.name}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted">{mcpTarget(s)}</span>
                <button
                  type="button"
                  disabled={!!mcpRefused()}
                  aria-label={t("web.agent.removeNamed", { name: s.name })}
                  onClick={() => props.patch({ ...props.draft, mcpServers: props.draft.mcpServers.filter((x) => x.name !== s.name) })}
                  class="cursor-pointer text-xs text-muted hover:text-berry"
                >
                  {t("web.agent.remove")}
                </button>
              </div>
            )}
          </For>
          <div class="flex flex-wrap items-center gap-1.5">
            <Segmented
              label={t("web.agent.mcpKind")}
              value={type()}
              options={[
                { value: "stdio", label: "stdio" },
                { value: "http", label: "http" },
              ]}
              onChange={setType}
            />
            <TextInput
              aria-label={t("web.agent.mcpName")}
              disabled={!!mcpRefused()}
              placeholder={t("web.agent.name")}
              class="w-28"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <TextInput
              aria-label={t("web.agent.mcpTarget")}
              disabled={!!mcpRefused()}
              placeholder={type() === "stdio" ? "npx -y @scope/server" : "https://…/mcp"}
              class="min-w-40 flex-1 font-mono"
              value={target()}
              onInput={(e) => setTarget(e.currentTarget.value)}
            />
            <Button disabled={!!mcpRefused() || !name().trim() || !target().trim()} onClick={add}>
              {t("web.agent.add")}
            </Button>
          </div>
        </div>
      </Labeled>
      <Labeled
        label={t("web.agent.disallowed")}
        hint={toolsRefused() ?? t("web.agent.disallowedHint")}
        error={toolsRefused() && props.draft.disallowedTools.length > 0 ? toolsRefused() : undefined}
      >
        <ChipsInput
          label={t("web.agent.disallowed")}
          placeholder={t("web.agent.disallowedExample")}
          disabled={!!toolsRefused()}
          value={props.draft.disallowedTools}
          onChange={(disallowedTools) => props.patch({ ...props.draft, disallowedTools })}
        />
        <Show when={!toolsRefused() ? props.runtime?.tools : undefined}>
          {(tools) => (
            <div class="flex flex-wrap gap-1 pt-1.5">
              <For each={tools().filter((tool) => !props.draft.disallowedTools.includes(tool.name))}>
                {(tool) => (
                  <button
                    type="button"
                    onClick={() => props.patch({ ...props.draft, disallowedTools: [...props.draft.disallowedTools, tool.name] })}
                    class="cursor-pointer rounded border border-line bg-page px-1.5 py-px font-mono text-xs text-muted hover:bg-hover hover:text-ink"
                  >
                    + {tool.name}
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
      </Labeled>
      <Labeled label={t("web.agent.ownMcp", { runtime: props.runtime?.preset.label ?? props.draft.runtime })} tip={t("web.agent.ownMcpTip")}>
        <Inventory entries={props.runtime?.mcpServers} />
      </Labeled>
    </>
  );
}

function Inventory(props: { entries?: InventoryEntry[] | null }) {
  return (
    <Switch
      fallback={
        <ul class="flex flex-col gap-1">
          <For each={props.entries}>
            {(e) => (
              <li class="flex items-baseline gap-2">
                <span class={["font-mono text-sm", { "text-muted line-through": e.enabled === false }]}>{e.name}</span>
                <span class="min-w-0 flex-1 truncate text-xs text-muted">{e.description}</span>
                <Show when={e.source}>
                  <span class="max-w-40 truncate text-xs text-muted">{e.source}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      }
    >
      <Match when={!props.entries}>
        <span class="text-xs text-muted">{t("web.agent.unreported")}</span>
      </Match>
      <Match when={props.entries!.length === 0}>
        <span class="text-xs text-muted">{t("web.agent.none")}</span>
      </Match>
    </Switch>
  );
}
