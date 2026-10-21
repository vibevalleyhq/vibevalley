// One profile, made or edited: its
// look on the left, the helper on its bed in the middle, what it is and runs on in tabs on the right; what would keep the
// manager from sending it, the server's answer (agent.check), under them.

import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useQueryClient } from "@tanstack/solid-query";
import {
  type Agent,
  type AgentIssue,
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
import { api, reasonOf } from "../../data/api";
import { castOf, castPrefix, cropSprite, outfitLabel, type Pose, randomLook, speciesLabel, stagePoses } from "../../rules/cast";
import { runtimeName } from "../../rules/skills";
import { toast } from "../../ui/toasts";
import { A } from "../../app/A";
import { useRouter, useSearch } from "../../app/router";
import { aria } from "../../app/util";
import { useAgentIssues } from "../../data/agents";
import { ready, useAgents, useRuntimes, useSprites } from "../../data/query";
import { RuntimeIcon } from "../../farm/hud/QuotaPill";
import { Button } from "../../ui/Button";
import { ChipsInput, KeyValueEditor } from "../../ui/Chips";
import { AgentFace } from "../../ui/Face";
import { Select, TextArea, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { PoseSprite } from "../../ui/PoseSprite";
import { Segmented } from "../../ui/Segmented";
import { Toggle } from "../kit";
import { MemoryPanel } from "../Memory";
import { useSkills } from "../settings/SkillsPage";
import { TrajectoryList } from "../Trajectory";

const unknownFacts: RuntimeFacts = { steer: false, refused: {}, capabilities: [], inProcess: false };
const factsOf = (info: RuntimeInfo | undefined) => info?.facts ?? unknownFacts;

export function newAgent(runtime: string, catalog: readonly RuntimeInfo[]): Agent {
  const info = catalog.find((r) => r.id === runtime);
  return {
    id: "",
    name: `新的 ${runtimeName(catalog, runtime)}`,
    role: "",
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
      <Match when={agents.error}>{(e) => <p class="p-8 text-sm text-muted">问不到服务端的档案：{reasonOf(e())}</p>}</Match>
      <Match when={!loaded() || (isNew() && !ready(runtimes, undefined))}>
        <p class="p-8 text-sm text-muted">{isNew() && runtimes.error ? `读不到农机：${reasonOf(runtimes.error)}` : "读取配置…"}</p>
      </Match>
      <Match when={!isNew() && !saved()}>
        <p class="p-8 text-sm text-muted">
          没有这个帮工。
          <A href="/agents" class="underline">
            回到全部帮工
          </A>
        </p>
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
  const allIssues = useAgentIssues(() => [draft()]);
  const issues = () => allIssues()[draft().id] ?? [];
  const dirty = () => isNew || !same(props.saved, draft());
  const nameTaken = () => props.all.some((a) => a.id !== draft().id && a.name === draft().name.trim());

  const save = async () => {
    setSaving(true);
    const d = draft();
    const body = { ...d, name: d.name.trim() || "无名 agent" };
    try {
      const got = isNew ? await api.agent.create({ body }) : await api.agent.save({ id: d.id, body });
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
        ← 全部帮工
      </A>
      <span class="text-sm text-faint">/</span>
      <span class="flex min-w-0 flex-1 items-center gap-3">
        <span class="truncate text-lg font-semibold">{draft().name || "无名帮工"}</span>
        <span class={["shrink-0 rounded px-1.5 text-xs", isNew || dirty() ? "bg-hat text-bark-900" : "bg-hover text-muted"]}>
          {isNew ? "新的" : dirty() ? "没保存" : "已保存"}
        </span>
      </span>
      <span class="flex flex-wrap items-center gap-2">
        <Show when={props.saved}>
          {(saved) => (
            <>
              <DeleteButton agent={saved()} />
              <Show when={dirty()}>
                <Button onClick={() => setDraft(saved())}>放弃改动</Button>
              </Show>
            </>
          )}
        </Show>
        <Button tone="primary" disabled={!dirty() || saving() || nameTaken()} onClick={() => void save()}>
          {saving() ? "保存中…" : isNew ? "捏好了，保存" : "保存"}
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
              ← 回到档案
            </button>
            <span
              class="text-sm font-semibold"
              title="它派出去的每个帮工，从接活起的每一步：收到的话、用的每个工具（点一行看输入和输出）、说的话。收工以后步骤留 30 天，帮工本身一直列着。"
            >
              轨迹
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
            <Issues issues={issues()} />
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
    <Show when={sure()} fallback={<Button onClick={() => setSure(true)}>删除</Button>}>
      <span class="flex items-center gap-2">
        <span class="text-sm text-muted">删掉 {props.agent.name}？</span>
        <Button tone="danger" onClick={() => void remove()}>
          删除
        </Button>
        <Button onClick={() => setSure(false)}>算了</Button>
      </span>
    </Show>
  );
}

function Issues(props: { issues: AgentIssue[] }) {
  return (
    <Show
      when={props.issues.length > 0}
      fallback={
        <p class="flex items-center gap-1.5 border-t border-line px-4 py-3 text-sm text-[#3f6427]">
          <Icon name="mark-check" size={12} />
          配置没问题，可以派活。
        </p>
      }
    >
      <ul aria-label="派不出去的原因" class="flex max-h-40 flex-col gap-1 overflow-y-auto border-t border-line px-4 py-3">
        <For each={props.issues}>
          {(i) => (
            <li class={["flex items-start gap-1.5 text-sm", i.level === "error" ? "text-berry" : "text-[#b8682a]"]}>
              <Icon name={i.level === "error" ? "mark-cross" : "mark-warn"} size={12} class="mt-1" />
              {i.level === "error" ? "派不出去：" : ""}
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
        <Button icon="button-replay" onClick={() => props.onChange(randomLook())}>
          随机一个
        </Button>
      </div>
      <Labeled label="在农场里是" hint="只是长相：同一个 runtime 可以是不同的动物。">
        <div class="grid grid-cols-4 gap-1.5">
          <For each={SpeciesValues}>
            {(species) => (
              <Tile active={cast().species === species} label={speciesLabel[species]} onClick={() => props.onChange({ ...props.draft.look, species })}>
                <AgentFace agentId={props.draft.id} look={{ ...props.draft.look, species, outfit: cast().outfit }} size={48} />
              </Tile>
            )}
          </For>
        </div>
      </Labeled>
      <Labeled label="穿什么">
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
        <span class="rounded-md bg-paper/92 px-3 py-0.5 text-lg">{props.draft.name || "无名 agent"}</span>
        <Show when={props.draft.role}>
          <span class="max-w-96 rounded bg-paper/75 px-2 py-px text-center text-xs">{props.draft.role}</span>
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
    ["who", "身份"],
    ["runtime", "能力"],
    ["persona", "人设"],
    ["skills", "技能"],
    ["tools", "工具"],
    ["env", "环境"],
    ...(props.isNew
      ? []
      : ([
          ["memory", "记性"],
          ["trajectories", "轨迹"],
        ] as [Tab, string][])),
  ];
  const envRefused = () => facts().refused[sessionEnv];
  const draft = () => props.draft;
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="档案的" class="flex flex-wrap gap-0.5 border-b border-line px-3 py-2">
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
            <Labeled label="名字" tip="管家和字幕里都叫这个名字，说话时也可以直接点名。" error={props.nameTaken ? "已经有同名的 agent 了" : undefined}>
              <TextInput aria-label="名字" value={draft().name} onInput={(e) => props.patch({ ...draft(), name: e.currentTarget.value })} />
            </Labeled>
            <Labeled label="职责" tip="一句话。管家挑人时会读。">
              <TextInput
                aria-label="职责"
                placeholder="比如：写接口、改 server、跑 Go 测试"
                value={draft().role}
                onInput={(e) => props.patch({ ...draft(), role: e.currentTarget.value })}
              />
            </Labeled>
            <Labeled label="适合的活" tip="用户的话里出现这些词，管家选「自动」时就优先派它。回车添加。">
              <ChipsInput label="适合的活" placeholder="前端、测试、文档…" value={draft().tags} onChange={(tags) => props.patch({ ...draft(), tags })} />
            </Labeled>
            <Toggle
              label="启用"
              hint="停用后管家不会派它，名字点到也会拒绝。"
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
            <Labeled label="默认项目" tip="工作目录（VIBEVALLEY_WORK_ROOT）下的一个文件夹。管家派活没说项目时用它；留空时派活必须说在哪个项目。">
              <TextInput
                aria-label="默认项目"
                class="font-mono"
                placeholder="比如 clock-in"
                value={draft().workdir}
                onInput={(e) => props.patch({ ...draft(), workdir: e.currentTarget.value })}
              />
            </Labeled>
            <Toggle
              label="每个帮工一个 git worktree"
              hint="每个帮工在自己的分支上改，几个帮工不会互相覆盖；收获时合进项目。关掉就直接在项目里改，没有分支可合。"
              checked={draft().worktree}
              onChange={(worktree) => props.patch({ ...draft(), worktree })}
            />
            <Labeled
              label="环境变量"
              hint={envRefused() ?? "叠加在 runtime 设置的环境变量之上。"}
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

/** A label, what sits at its right, the control and a hint (or what is wrong) under it. */
function Labeled(props: { label: string; tip?: string; hint?: string; error?: string; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-2">
        <span class="flex-1 text-xs font-medium text-muted" title={props.tip}>
          {props.label}
        </span>
        {props.aside}
      </div>
      {props.children}
      <Show when={props.error} fallback={<Show when={props.hint ?? props.tip}>{(h) => <span class="text-xs text-faint">{h()}</span>}</Show>}>
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
    <Labeled label="农机" tip="换农机会清掉模型和推理强度；长相（动物和衣服）不变。">
      <Show when={runtimes().length > 0} fallback={<span class="text-xs text-muted">读取农机…</span>}>
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
                    ? (inst.version ?? "可用")
                    : "已停用"
                  : inst.status === "checking"
                    ? "检测中…"
                    : "这台机器上没有";
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
      <Labeled label="模型" hint={models().length === 0 ? "这个 runtime 现在报不出模型列表。" : undefined}>
        <Select
          label="模型"
          value={props.draft.model}
          placeholder={`runtime 默认${fallback() ? `（${fallback()}）` : ""}`}
          options={models().map((m) => ({ value: m.id, label: m.effortLevels.length > 0 ? `${m.name}（${m.effortLevels.length} 档推理）` : m.name }))}
          onChange={(m) => props.patch({ ...props.draft, model: m, effort: "" })}
        />
      </Labeled>
      <Labeled
        label="推理强度"
        hint={refusedEffort() ?? (levels().length === 0 ? `${model()?.name ?? "这个模型"}没有推理强度可选。` : "默认由 runtime 决定。")}
      >
        <div>
          <Segmented
            label="推理强度"
            value={props.draft.effort}
            options={[{ value: "", label: "默认" }, ...levels().map((l) => ({ value: l, label: l, disabled: !!refusedEffort() }))]}
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
      <h3 class="text-sm font-semibold">{props.info ? props.info.preset.label : props.runtime} 能做什么</h3>
      <Show when={props.info} fallback={<span class="text-sm">读取农机…</span>}>
        <span class="flex items-start gap-1.5 text-sm">
          <Icon name={facts().steer ? "mark-check" : "mark-cross"} size={12} class="mt-1" />
          {facts().steer ? "能在干活时接话（steer）" : "干活时不能插话，话会排到这一轮之后"}
        </span>
        <span class="text-sm">{facts().inProcess ? "· 跑在 server 进程里（Node SDK）" : "· 作为单独的命令行进程运行"}</span>
        <For each={Object.entries(facts().refused)}>
          {([option, reason]) => (
            <span class="text-sm text-muted">
              不接受 <span class="font-mono text-ink">{option}</span>：{reason}
            </span>
          )}
        </For>
      </Show>
    </section>
  );
}

const personaModes: { value: PersonaMode; label: string; detail: string; option?: string }[] = [
  { value: "append", label: "追加到系统提示", detail: "保留 runtime 自带的工作方式，在后面加上人设。大多数情况选这个。", option: sessionAppendSystemPrompt },
  { value: "replace", label: "替换系统提示", detail: "整段换掉 runtime 自带的系统提示。只有你清楚自己在做什么时才用。", option: sessionSystemPrompt },
  { value: "prompt", label: "写进工单开头", detail: "每张工单前面加上人设。所有 runtime 都能用，但会被长对话冲淡。" },
];

function Persona(props: { draft: Agent; facts: RuntimeFacts; patch: Patch }) {
  const mode = () => personaModes.find((m) => m.value === props.draft.personaMode);
  return (
    <>
      <Labeled label="人设" tip="它是谁、怎么干活、什么不做。会按下面的方式交给 runtime。">
        <TextArea
          aria-label="人设"
          rows={9}
          placeholder="你是一个谨慎的后端工程师。先读懂现有代码再动手……"
          value={props.draft.persona}
          onInput={(e) => props.patch({ ...props.draft, persona: e.currentTarget.value })}
        />
      </Labeled>
      <Labeled label="交给 runtime 的方式" hint={mode()?.detail}>
        <div>
          <Segmented
            label="交给 runtime 的方式"
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
        label="技能库"
        tip="选中的技能跟人设一起交给帮工，每个技能一节。"
        aside={
          <A href="/settings/skills" class="text-xs text-muted underline">
            管理技能库 →
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
                      <Icon name="mark-check" size={12} />
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
      <Labeled label={`${props.runtime?.preset.label ?? props.draft.runtime} 自己装的技能`} tip="runtime 自己报告的，在这台机器上已经能用，不用在这里勾。">
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
    const t = target().trim();
    if (!n || !t) return;
    const words = t.split(/\s+/);
    const server: MCPServer =
      type() === "stdio" ? { type: "stdio", name: n, command: words[0]!, args: words.slice(1), env: {} } : { type: "http", name: n, url: t, headers: {} };
    props.patch({ ...props.draft, mcpServers: [...props.draft.mcpServers.filter((s) => s.name !== n), server] });
    setName("");
    setTarget("");
  };
  return (
    <>
      <Labeled
        label="MCP 服务器"
        hint={mcpRefused() ?? "开 session 时交给 runtime（oar 的 SessionOptions.mcpServers）。"}
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
                  aria-label={`删除 ${s.name}`}
                  onClick={() => props.patch({ ...props.draft, mcpServers: props.draft.mcpServers.filter((x) => x.name !== s.name) })}
                  class="cursor-pointer text-xs text-muted hover:text-berry"
                >
                  删除
                </button>
              </div>
            )}
          </For>
          <div class="flex flex-wrap items-center gap-1.5">
            <Segmented
              label="MCP 的种类"
              value={type()}
              options={[
                { value: "stdio", label: "stdio" },
                { value: "http", label: "http" },
              ]}
              onChange={setType}
            />
            <TextInput
              aria-label="MCP 名字"
              disabled={!!mcpRefused()}
              placeholder="名字"
              class="w-28"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <TextInput
              aria-label="MCP 命令或地址"
              disabled={!!mcpRefused()}
              placeholder={type() === "stdio" ? "npx -y @scope/server" : "https://…/mcp"}
              class="min-w-40 flex-1 font-mono"
              value={target()}
              onInput={(e) => setTarget(e.currentTarget.value)}
            />
            <Button disabled={!!mcpRefused() || !name().trim() || !target().trim()} onClick={add}>
              添加
            </Button>
          </div>
        </div>
      </Labeled>
      <Labeled
        label="禁用的工具"
        hint={toolsRefused() ?? "这些工具这个 agent 不能用。下面 runtime 报告的工具点一下就能加进来。"}
        error={toolsRefused() && props.draft.disallowedTools.length > 0 ? toolsRefused() : undefined}
      >
        <ChipsInput
          label="禁用的工具"
          placeholder="比如 WebSearch"
          disabled={!!toolsRefused()}
          value={props.draft.disallowedTools}
          onChange={(disallowedTools) => props.patch({ ...props.draft, disallowedTools })}
        />
        <Show when={!toolsRefused() ? props.runtime?.tools : undefined}>
          {(tools) => (
            <div class="flex flex-wrap gap-1 pt-1.5">
              <For each={tools().filter((t) => !props.draft.disallowedTools.includes(t.name))}>
                {(t) => (
                  <button
                    type="button"
                    onClick={() => props.patch({ ...props.draft, disallowedTools: [...props.draft.disallowedTools, t.name] })}
                    class="cursor-pointer rounded border border-line bg-page px-1.5 py-px font-mono text-xs text-muted hover:bg-hover hover:text-ink"
                  >
                    + {t.name}
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
      </Labeled>
      <Labeled label={`${props.runtime?.preset.label ?? props.draft.runtime} 自己连的 MCP`} tip="runtime 自己报告的，和上面加的叠在一起。">
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
        <span class="text-xs text-muted">这个 runtime 不报告这一项。</span>
      </Match>
      <Match when={props.entries!.length === 0}>
        <span class="text-xs text-muted">没有。</span>
      </Match>
    </Switch>
  );
}
