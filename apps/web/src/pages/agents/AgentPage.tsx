// One profile, made or edited: its
// look on the left, the helper on its bed in the middle, what it is and runs on in tabs on the right; what would keep the
// manager from sending it, the server's answer (agent.check), under them.

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
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
import { useAgentIssues, useAgents } from "../../data/agents";
import { api, reasonOf } from "../../data/api";
import { useRuntimes } from "../../data/runtimes";
import { RuntimeIcon } from "../../farm/hud/QuotaPill";
import { castOf, cropSprite, outfitLabel, type Pose, randomLook, speciesLabel, stagePoses } from "../../rules/cast";
import { runtimeName } from "../../rules/skills";
import { Button } from "../../ui/Button";
import { ChipsInput, KeyValueEditor } from "../../ui/Chips";
import { AgentFace, castPrefix, useSprites } from "../../ui/Face";
import { Select, TextArea, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { PoseSprite } from "../../ui/PoseSprite";
import { Segmented } from "../../ui/Segmented";
import { useToast } from "../../ui/Toast";
import { Switch } from "../kit";
import { MemoryPanel } from "../Memory";
import { TrajectoryList } from "../Trajectory";
import { useSkills } from "../settings/SkillsPage";

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

export function AgentPage({ id }: { id: string }) {
  const isNew = id === "new";
  const [params] = useSearchParams();
  const agents = useAgents();
  const runtimes = useRuntimes();
  if (agents.error) return <p className="p-8 text-sm text-muted">问不到服务端的档案：{reasonOf(agents.error)}</p>;
  if (!agents.data || (isNew && !runtimes.data))
    return <p className="p-8 text-sm text-muted">{isNew && runtimes.error ? `读不到农机：${reasonOf(runtimes.error)}` : "读取配置…"}</p>;
  const saved = agents.data.find((a) => a.id === id);
  if (!isNew && !saved)
    return (
      <p className="p-8 text-sm text-muted">
        没有这个帮工。
        <Link to="/agents" className="underline">
          回到全部帮工
        </Link>
      </p>
    );
  return <Creator saved={saved} start={saved ?? newAgent(params.get("runtime") ?? "claude", runtimes.data ?? [])} all={agents.data} />;
}

function Creator({ saved, start, all }: { saved?: Agent; start: Agent; all: readonly Agent[] }) {
  const isNew = !saved;
  const [draft, setDraft] = useState(start);
  const [pose, setPose] = useState<Pose>("idle");
  const [saving, setSaving] = useState(false);
  const [trajectories, setTrajectories] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const runtime = useRuntimes().data?.find((r) => r.id === draft.runtime);
  const issues = useAgentIssues([draft])[draft.id] ?? [];
  const dirty = isNew || !same(saved, draft);
  const nameTaken = all.some((a) => a.id !== draft.id && a.name === draft.name.trim());

  const save = async () => {
    setSaving(true);
    const name = draft.name.trim();
    const body = { ...draft, name: name || "无名 agent" };
    try {
      const got = isNew ? await api.agent.create({ body }) : await api.agent.save({ id: draft.id, body });
      client.setQueryData<Agent[]>(["agents"], (list) => (list ? [...list.filter((a) => a.id !== got.id), got] : list));
      await client.invalidateQueries({ queryKey: ["agents"] });
      setDraft(got);
      if (isNew) void navigate(`/agents/${encodeURIComponent(got.id)}`);
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setSaving(false);
    }
  };

  const bar = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-3">
      <Link to="/agents" className="text-sm text-muted hover:underline">
        ← 全部帮工
      </Link>
      <span className="text-sm text-faint">/</span>
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <span className="truncate text-lg font-semibold">{draft.name || "无名帮工"}</span>
        <span className={`shrink-0 rounded px-1.5 text-xs ${isNew || dirty ? "bg-hat text-bark-900" : "bg-hover text-muted"}`}>
          {isNew ? "新的" : dirty ? "没保存" : "已保存"}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {saved && <DeleteButton agent={saved} />}
        {saved && dirty && <Button onClick={() => setDraft(saved)}>放弃改动</Button>}
        <Button tone="primary" disabled={!dirty || saving || nameTaken} onClick={save}>
          {saving ? "保存中…" : isNew ? "捏好了，保存" : "保存"}
        </Button>
      </span>
    </div>
  );

  if (trajectories)
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 px-4 pb-4">
        {bar}
        <div className="flex items-center gap-3">
          <button type="button" className="cursor-pointer text-sm text-muted hover:underline" onClick={() => setTrajectories(false)}>
            ← 回到档案
          </button>
          <span
            className="text-sm font-semibold"
            title="它派出去的每个帮工，从接活起的每一步：收到的话、用的每个工具（点一行看输入和输出）、说的话。收工以后步骤留 30 天，帮工本身一直列着。"
          >
            轨迹
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <TrajectoryList agent={draft.id} />
        </div>
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col px-4 pb-4">
      {bar}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pt-3 lg:flex-row lg:overflow-hidden">
        <div className="shrink-0 rounded-lg border border-line bg-page p-4 lg:w-76 lg:overflow-y-auto">
          <LookPanel draft={draft} onChange={(look) => setDraft({ ...draft, look })} />
        </div>
        <div className="flex min-h-104 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-page">
          <Stage draft={draft} pose={pose} />
          <div className="flex flex-wrap justify-center gap-1.5 p-3">
            {stagePoses.map((p) => (
              <button
                key={p.pose}
                type="button"
                aria-pressed={pose === p.pose}
                onClick={() => setPose(p.pose)}
                className={`h-6 cursor-pointer rounded-full px-2.5 text-xs ${pose === p.pose ? "bg-ink text-page" : "bg-hover hover:bg-selected"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-page lg:w-108">
          <ConfigTabs draft={draft} runtime={runtime} patch={setDraft} nameTaken={nameTaken} isNew={isNew} onTrajectories={() => setTrajectories(true)} />
          <Issues issues={issues} />
        </div>
      </div>
    </div>
  );
}

function DeleteButton({ agent }: { agent: Agent }) {
  const [sure, setSure] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  if (!sure) return <Button onClick={() => setSure(true)}>删除</Button>;
  return (
    <span className="flex items-center gap-2">
      <span className="text-sm text-muted">删掉 {agent.name}？</span>
      <Button
        tone="danger"
        onClick={async () => {
          try {
            await api.agent.delete({ id: agent.id });
            await client.invalidateQueries({ queryKey: ["agents"] });
            void navigate("/agents");
          } catch (e) {
            toast(reasonOf(e));
          }
        }}
      >
        删除
      </Button>
      <Button onClick={() => setSure(false)}>算了</Button>
    </span>
  );
}

function Issues({ issues }: { issues: AgentIssue[] }) {
  if (issues.length === 0)
    return (
      <p className="flex items-center gap-1.5 border-t border-line px-4 py-3 text-sm text-[#3f6427]">
        <Icon name="mark-check" size={12} />
        配置没问题，可以派活。
      </p>
    );
  return (
    <ul aria-label="派不出去的原因" className="flex max-h-40 flex-col gap-1 overflow-y-auto border-t border-line px-4 py-3">
      {issues.map((i) => (
        <li key={i.field + i.text} className={`flex items-start gap-1.5 text-sm ${i.level === "error" ? "text-berry" : "text-[#b8682a]"}`}>
          <Icon name={i.level === "error" ? "mark-cross" : "mark-warn"} size={12} className="mt-1" />
          {i.level === "error" ? "派不出去：" : ""}
          {i.text}
        </li>
      ))}
    </ul>
  );
}

function LookPanel({ draft, onChange }: { draft: Agent; onChange: (look: Agent["look"]) => void }) {
  const cast = castOf(draft.look, draft.id);
  const sprites = useSprites().data;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button icon="button-replay" onClick={() => onChange(randomLook())}>
          随机一个
        </Button>
      </div>
      <Labeled label="在农场里是" hint="只是长相：同一个 runtime 可以是不同的动物。">
        <div className="grid grid-cols-4 gap-1.5">
          {SpeciesValues.map((species) => (
            <Tile key={species} active={cast.species === species} label={speciesLabel[species]} onClick={() => onChange({ ...draft.look, species })}>
              <AgentFace agentId={draft.id} look={{ ...draft.look, species, outfit: cast.outfit }} size={48} />
            </Tile>
          ))}
        </div>
      </Labeled>
      <Labeled label="穿什么">
        <div className="grid grid-cols-4 gap-1.5">
          {OutfitValues.map((outfit) => {
            const name = sprites ? `${castPrefix({ ...draft.look, species: cast.species, outfit }, draft.id, (n) => n in sprites)}-down` : undefined;
            return (
              <Tile key={outfit} active={cast.outfit === outfit} label={outfitLabel[outfit]} onClick={() => onChange({ ...draft.look, outfit })}>
                <span className="flex h-16 items-center justify-center">
                  {name && <img src={`/pixel/${name}.png`} alt="" className="h-16 object-contain [image-rendering:pixelated]" />}
                </span>
              </Tile>
            );
          })}
        </div>
      </Labeled>
    </div>
  );
}

function Tile({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`flex cursor-pointer flex-col items-center gap-0.5 rounded-md border px-1 pt-1 pb-1.5 ${active ? "border-ink/40 bg-selected" : "border-line hover:bg-hover"}`}
    >
      {children}
      <span className={`text-xs ${active ? "font-semibold" : "text-muted"}`}>{label}</span>
    </button>
  );
}

/** The helper on the bed its pose goes with, its name under it. */
function Stage({ draft, pose }: { draft: Agent; pose: Pose }) {
  const cast = castOf(draft.look, draft.id);
  const crop = stagePoses.find((p) => p.pose === pose)!.crop;
  return (
    <div
      className="relative flex flex-1 items-center justify-center overflow-hidden"
      style={{ background: "radial-gradient(60% 60% at 50% 45%, #c7dd9a, #9cc069 60%, #7ea64f)" }}
    >
      <div className="relative h-72 w-96 max-w-full">
        <img
          src={`/pixel/${cropSprite(crop)}.png`}
          alt=""
          className="absolute bottom-6 w-72 [image-rendering:pixelated]"
          style={{ left: 192 - 288 * 0.62 }}
          onError={(e) => (e.currentTarget.style.display = "none")}
        />
        <div className="absolute right-24 bottom-2 translate-x-1/2">
          <PoseSprite cast={cast} pose={pose} height={224} />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex flex-col items-center gap-1">
        <span className="rounded-md bg-paper/92 px-3 py-0.5 text-lg">{draft.name || "无名 agent"}</span>
        {draft.role && <span className="max-w-96 rounded bg-paper/75 px-2 py-px text-center text-xs">{draft.role}</span>}
      </div>
      <span className="pointer-events-none absolute top-3 right-4 rounded bg-paper/75 px-2 py-px text-xs">
        {speciesLabel[cast.species]} · {outfitLabel[cast.outfit]}
      </span>
    </div>
  );
}

type Tab = "who" | "runtime" | "persona" | "skills" | "tools" | "env" | "memory" | "trajectories";

function ConfigTabs({
  draft,
  runtime,
  patch,
  nameTaken,
  isNew,
  onTrajectories,
}: {
  draft: Agent;
  runtime?: RuntimeInfo;
  patch: (a: Agent) => void;
  nameTaken: boolean;
  isNew: boolean;
  onTrajectories: () => void;
}) {
  const [tab, setTab] = useState<Tab>("who");
  const facts = factsOf(runtime);
  const tabs: [Tab, string][] = [
    ["who", "身份"],
    ["runtime", "能力"],
    ["persona", "人设"],
    ["skills", "技能"],
    ["tools", "工具"],
    ["env", "环境"],
    ...(isNew
      ? []
      : ([
          ["memory", "记性"],
          ["trajectories", "轨迹"],
        ] as [Tab, string][])),
  ];
  const envRefused = facts.refused[sessionEnv];
  let body: ReactNode;
  switch (tab) {
    case "who":
      body = (
        <>
          <Labeled label="名字" tip="管家和字幕里都叫这个名字，说话时也可以直接点名。" error={nameTaken ? "已经有同名的 agent 了" : undefined}>
            <TextInput aria-label="名字" value={draft.name} onChange={(e) => patch({ ...draft, name: e.target.value })} />
          </Labeled>
          <Labeled label="职责" tip="一句话。管家挑人时会读。">
            <TextInput
              aria-label="职责"
              placeholder="比如：写接口、改 server、跑 Go 测试"
              value={draft.role}
              onChange={(e) => patch({ ...draft, role: e.target.value })}
            />
          </Labeled>
          <Labeled label="适合的活" tip="用户的话里出现这些词，管家选「自动」时就优先派它。回车添加。">
            <ChipsInput label="适合的活" placeholder="前端、测试、文档…" value={draft.tags} onChange={(tags) => patch({ ...draft, tags })} />
          </Labeled>
          <Switch label="启用" hint="停用后管家不会派它，名字点到也会拒绝。" checked={draft.enabled} onChange={(enabled) => patch({ ...draft, enabled })} />
        </>
      );
      break;
    case "runtime":
      body = (
        <>
          <RuntimeChoice draft={draft} patch={patch} />
          <ModelAndEffort draft={draft} runtime={runtime} patch={patch} />
          <Facts runtime={draft.runtime} info={runtime} />
        </>
      );
      break;
    case "persona":
      body = <Persona draft={draft} facts={facts} patch={patch} />;
      break;
    case "skills":
      body = <SkillPicker draft={draft} runtime={runtime} patch={patch} />;
      break;
    case "tools":
      body = <Tools draft={draft} runtime={runtime} patch={patch} />;
      break;
    case "env":
      body = (
        <>
          <Labeled label="默认项目" tip="工作目录（VIBEVALLEY_WORK_ROOT）下的一个文件夹。管家派活没说项目时用它；留空时派活必须说在哪个项目。">
            <TextInput
              aria-label="默认项目"
              className="font-mono"
              placeholder="比如 clock-in"
              value={draft.workdir}
              onChange={(e) => patch({ ...draft, workdir: e.target.value })}
            />
          </Labeled>
          <Switch
            label="每个帮工一个 git worktree"
            hint="每个帮工在自己的分支上改，几个帮工不会互相覆盖；收获时合进项目。关掉就直接在项目里改，没有分支可合。"
            checked={draft.worktree}
            onChange={(worktree) => patch({ ...draft, worktree })}
          />
          <Labeled
            label="环境变量"
            hint={envRefused ?? "叠加在 runtime 设置的环境变量之上。"}
            error={envRefused && Object.keys(draft.env).length > 0 ? envRefused : undefined}
          >
            <KeyValueEditor value={draft.env} disabled={!!envRefused} onChange={(env) => patch({ ...draft, env })} />
          </Labeled>
        </>
      );
      break;
    case "memory":
      body = <MemoryPanel agent={draft.id} />;
      break;
    case "trajectories":
      body = null;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="档案的" className="flex flex-wrap gap-0.5 border-b border-line px-3 py-2">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            onClick={() => (t === "trajectories" ? onTrajectories() : setTab(t))}
            className={`h-7 cursor-pointer rounded-md px-2.5 text-sm ${t === tab ? "bg-selected font-semibold" : "text-muted hover:bg-hover hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">{body}</div>
    </div>
  );
}

/** A label, what sits at its right, the control and a hint (or what is wrong) under it. */
function Labeled({
  label,
  tip,
  hint,
  error,
  aside,
  children,
}: {
  label: string;
  tip?: string;
  hint?: string;
  error?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium text-muted" title={tip}>
          {label}
        </span>
        {aside}
      </div>
      {children}
      {error ? <span className="text-xs text-berry">{error}</span> : (hint ?? tip) && <span className="text-xs text-faint">{hint ?? tip}</span>}
    </div>
  );
}

function RuntimeChoice({ draft, patch }: { draft: Agent; patch: (a: Agent) => void }) {
  const runtimes = useRuntimes().data ?? [];
  const choose = (info: RuntimeInfo) => {
    const f = factsOf(info);
    const cannotTakeSystemPrompt = !!f.refused[sessionAppendSystemPrompt] || !!f.refused[sessionSystemPrompt];
    // A persona the new runtime can't take as a system prompt goes into each job instead.
    patch({
      ...draft,
      runtime: info.id,
      model: "",
      effort: "",
      personaMode: draft.personaMode !== "prompt" && cannotTakeSystemPrompt ? "prompt" : draft.personaMode,
    });
  };
  return (
    <Labeled label="农机" tip="换农机会清掉模型和推理强度；长相（动物和衣服）不变。">
      {runtimes.length === 0 ? (
        <span className="text-xs text-muted">读取农机…</span>
      ) : (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {runtimes.map((info) => {
            const inst = info.installation;
            const available = inst.status === "available";
            const ok = available && info.settings.enabled;
            const active = draft.runtime === info.id;
            const status = available
              ? info.settings.enabled
                ? (inst.version ?? "可用")
                : "已停用"
              : inst.status === "checking"
                ? "检测中…"
                : "这台机器上没有";
            return (
              <button
                key={info.id}
                type="button"
                aria-pressed={active}
                aria-label={info.preset.label}
                onClick={() => choose(info)}
                className={`flex cursor-pointer items-center gap-2 rounded-md border p-2 text-left ${active ? "border-ink/40 bg-selected" : "border-line hover:bg-hover"}`}
              >
                <span className={ok ? "" : "opacity-50 grayscale"}>
                  <RuntimeIcon runtime={info.id} size={32} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className={`truncate text-sm ${active ? "font-semibold" : "font-medium"}`}>{info.preset.label}</span>
                  <span className={`truncate text-xs ${ok ? "text-muted" : "text-berry"}`}>{status}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Labeled>
  );
}

function ModelAndEffort({ draft, runtime, patch }: { draft: Agent; runtime?: RuntimeInfo; patch: (a: Agent) => void }) {
  const models = runtime?.models ?? [];
  const defaultModel = runtime?.settings.defaultModel ?? "";
  const fallback = defaultModel || models.find((m) => m.isDefault)?.id || "";
  const model = models.find((m) => m.id === (draft.model || fallback));
  const refusedEffort = factsOf(runtime).refused[sessionEffort];
  const levels = model?.effortLevels ?? [];
  return (
    <>
      <Labeled label="模型" hint={models.length === 0 ? "这个 runtime 现在报不出模型列表。" : undefined}>
        <Select
          label="模型"
          value={draft.model}
          placeholder={`runtime 默认${fallback ? `（${fallback}）` : ""}`}
          options={models.map((m) => ({ value: m.id, label: m.effortLevels.length > 0 ? `${m.name}（${m.effortLevels.length} 档推理）` : m.name }))}
          onChange={(m) => patch({ ...draft, model: m, effort: "" })}
        />
      </Labeled>
      <Labeled label="推理强度" hint={refusedEffort ?? (levels.length === 0 ? `${model?.name ?? "这个模型"}没有推理强度可选。` : "默认由 runtime 决定。")}>
        <div>
          <Segmented
            label="推理强度"
            value={draft.effort}
            options={[{ value: "", label: "默认" }, ...levels.map((l) => ({ value: l, label: l, disabled: !!refusedEffort }))]}
            onChange={(effort) => patch({ ...draft, effort })}
          />
        </div>
      </Labeled>
    </>
  );
}

/** What it takes comes with runtime.list: until then, nothing is said rather than a guess. */
function Facts({ runtime, info }: { runtime: string; info?: RuntimeInfo }) {
  const facts = factsOf(info);
  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-line p-3">
      <h3 className="text-sm font-semibold">{info ? info.preset.label : runtime} 能做什么</h3>
      {!info ? (
        <span className="text-sm">读取农机…</span>
      ) : (
        <>
          <span className="flex items-start gap-1.5 text-sm">
            <Icon name={facts.steer ? "mark-check" : "mark-cross"} size={12} className="mt-1" />
            {facts.steer ? "能在干活时接话（steer）" : "干活时不能插话，话会排到这一轮之后"}
          </span>
          <span className="text-sm">{facts.inProcess ? "· 跑在 server 进程里（Node SDK）" : "· 作为单独的命令行进程运行"}</span>
          {Object.entries(facts.refused).map(([option, reason]) => (
            <span key={option} className="text-sm text-muted">
              不接受 <span className="font-mono text-ink">{option}</span>：{reason}
            </span>
          ))}
        </>
      )}
    </section>
  );
}

const personaModes: { value: PersonaMode; label: string; detail: string; option?: string }[] = [
  { value: "append", label: "追加到系统提示", detail: "保留 runtime 自带的工作方式，在后面加上人设。大多数情况选这个。", option: sessionAppendSystemPrompt },
  { value: "replace", label: "替换系统提示", detail: "整段换掉 runtime 自带的系统提示。只有你清楚自己在做什么时才用。", option: sessionSystemPrompt },
  { value: "prompt", label: "写进工单开头", detail: "每张工单前面加上人设。所有 runtime 都能用，但会被长对话冲淡。" },
];

function Persona({ draft, facts, patch }: { draft: Agent; facts: RuntimeFacts; patch: (a: Agent) => void }) {
  const mode = personaModes.find((m) => m.value === draft.personaMode);
  return (
    <>
      <Labeled label="人设" tip="它是谁、怎么干活、什么不做。会按下面的方式交给 runtime。">
        <TextArea
          aria-label="人设"
          rows={9}
          placeholder="你是一个谨慎的后端工程师。先读懂现有代码再动手……"
          value={draft.persona}
          onChange={(e) => patch({ ...draft, persona: e.target.value })}
        />
      </Labeled>
      <Labeled label="交给 runtime 的方式" hint={mode?.detail}>
        <div>
          <Segmented
            label="交给 runtime 的方式"
            value={draft.personaMode}
            options={personaModes.map((m) => ({
              value: m.value,
              label: m.label,
              disabled: !!m.option && !!facts.refused[m.option],
              title: m.option ? facts.refused[m.option] : undefined,
            }))}
            onChange={(personaMode) => patch({ ...draft, personaMode })}
          />
        </div>
      </Labeled>
    </>
  );
}

function SkillPicker({ draft, runtime, patch }: { draft: Agent; runtime?: RuntimeInfo; patch: (a: Agent) => void }) {
  const skills = useSkills().data ?? [];
  const toggle = (id: string) => patch({ ...draft, skills: draft.skills.includes(id) ? draft.skills.filter((s) => s !== id) : [...draft.skills, id] });
  return (
    <>
      <Labeled
        label="技能库"
        tip="选中的技能跟人设一起交给帮工，每个技能一节。"
        aside={
          <Link to="/settings/skills" className="text-xs text-muted underline">
            管理技能库 →
          </Link>
        }
      >
        <div className="flex flex-col gap-1.5">
          {skills.map((s) => {
            const on = draft.skills.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={s.name}
                onClick={() => toggle(s.id)}
                className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-left ${on ? "border-ink/40 bg-selected" : "border-line hover:bg-hover"}`}
              >
                <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border bg-page ${on ? "border-accent" : "border-ink/25"}`}>
                  {on && <Icon name="mark-check" size={12} />}
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{s.name}</span>
                  <span className="text-xs text-muted">{s.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Labeled>
      <Labeled label={`${runtime?.preset.label ?? draft.runtime} 自己装的技能`} tip="runtime 自己报告的，在这台机器上已经能用，不用在这里勾。">
        <Inventory entries={runtime?.skills} />
      </Labeled>
    </>
  );
}

const mcpTarget = (s: MCPServer) => (s.type === "stdio" ? [s.command, ...s.args].join(" ") : s.url);

function Tools({ draft, runtime, patch }: { draft: Agent; runtime?: RuntimeInfo; patch: (a: Agent) => void }) {
  const facts = factsOf(runtime);
  const mcpRefused = facts.refused[sessionMcpServers];
  const toolsRefused = facts.refused[sessionDisallowedTools];
  const [type, setType] = useState<"stdio" | "http">("stdio");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const add = () => {
    const n = name.trim();
    const t = target.trim();
    if (!n || !t) return;
    const words = t.split(/\s+/);
    const server: MCPServer =
      type === "stdio" ? { type: "stdio", name: n, command: words[0]!, args: words.slice(1), env: {} } : { type: "http", name: n, url: t, headers: {} };
    patch({ ...draft, mcpServers: [...draft.mcpServers.filter((s) => s.name !== n), server] });
    setName("");
    setTarget("");
  };
  return (
    <>
      <Labeled
        label="MCP 服务器"
        hint={mcpRefused ?? "开 session 时交给 runtime（oar 的 SessionOptions.mcpServers）。"}
        error={mcpRefused && draft.mcpServers.length > 0 ? mcpRefused : undefined}
      >
        <div className={`flex flex-col gap-1.5 ${mcpRefused ? "opacity-50" : ""}`}>
          {draft.mcpServers.map((s) => (
            <div key={s.name} className="flex items-center gap-2 rounded-md border border-line px-3 py-2">
              <span className="rounded bg-selected px-1.5 text-xs">{s.type}</span>
              <span className="text-sm font-medium">{s.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{mcpTarget(s)}</span>
              <button
                type="button"
                disabled={!!mcpRefused}
                aria-label={`删除 ${s.name}`}
                onClick={() => patch({ ...draft, mcpServers: draft.mcpServers.filter((x) => x.name !== s.name) })}
                className="cursor-pointer text-xs text-muted hover:text-berry"
              >
                删除
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-1.5">
            <Segmented
              label="MCP 的种类"
              value={type}
              options={[
                { value: "stdio", label: "stdio" },
                { value: "http", label: "http" },
              ]}
              onChange={setType}
            />
            <TextInput
              aria-label="MCP 名字"
              disabled={!!mcpRefused}
              placeholder="名字"
              className="w-28"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <TextInput
              aria-label="MCP 命令或地址"
              disabled={!!mcpRefused}
              placeholder={type === "stdio" ? "npx -y @scope/server" : "https://…/mcp"}
              className="min-w-40 flex-1 font-mono"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <Button disabled={!!mcpRefused || !name.trim() || !target.trim()} onClick={add}>
              添加
            </Button>
          </div>
        </div>
      </Labeled>
      <Labeled
        label="禁用的工具"
        hint={toolsRefused ?? "这些工具这个 agent 不能用。下面 runtime 报告的工具点一下就能加进来。"}
        error={toolsRefused && draft.disallowedTools.length > 0 ? toolsRefused : undefined}
      >
        <ChipsInput
          label="禁用的工具"
          placeholder="比如 WebSearch"
          disabled={!!toolsRefused}
          value={draft.disallowedTools}
          onChange={(disallowedTools) => patch({ ...draft, disallowedTools })}
        />
        {runtime?.tools && !toolsRefused && (
          <div className="flex flex-wrap gap-1 pt-1.5">
            {runtime.tools
              .filter((t) => !draft.disallowedTools.includes(t.name))
              .map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => patch({ ...draft, disallowedTools: [...draft.disallowedTools, t.name] })}
                  className="cursor-pointer rounded border border-line bg-page px-1.5 py-px font-mono text-xs text-muted hover:bg-hover hover:text-ink"
                >
                  + {t.name}
                </button>
              ))}
          </div>
        )}
      </Labeled>
      <Labeled label={`${runtime?.preset.label ?? draft.runtime} 自己连的 MCP`} tip="runtime 自己报告的，和上面加的叠在一起。">
        <Inventory entries={runtime?.mcpServers} />
      </Labeled>
    </>
  );
}

function Inventory({ entries }: { entries?: InventoryEntry[] | null }) {
  if (!entries) return <span className="text-xs text-muted">这个 runtime 不报告这一项。</span>;
  if (entries.length === 0) return <span className="text-xs text-muted">没有。</span>;
  return (
    <ul className="flex flex-col gap-1">
      {entries.map((e) => (
        <li key={e.name} className="flex items-baseline gap-2">
          <span className={`font-mono text-sm ${e.enabled === false ? "text-muted line-through" : ""}`}>{e.name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{e.description}</span>
          {e.source && <span className="max-w-40 truncate text-xs text-muted">{e.source}</span>}
        </li>
      ))}
    </ul>
  );
}
