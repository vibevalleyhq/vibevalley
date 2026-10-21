// 种植计划: the task graphs, a new one split by a helper, and
// the one shown: its state and actions, its steps in batches (each with who does it, what it waits on, what it
// concluded, and retry, skip, edit, remove, its history), its harvest, and the log of what happened. The words of the
// states and actions are the server's (stateTag, stateText, actionText).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GraphAction, GraphEvent, GraphState, Session, Task, TaskGraph, TaskState } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useAgents, useWorkAgents } from "../../data/agents";
import { useCore, useFrames } from "../../data/frame";
import { spentText } from "../../rules/chat";
import { lineCounts } from "../../rules/issueState";
import { AgentFace } from "../../ui/Face";
import { FarmSection, PxButton, PxField, PxPick, PxTextArea, PxTextInput, SpriteIcon } from "../kit";
import { useFarmCommands } from "../commands";
import { farm, useFarm } from "../store";
import { stationOfSession } from "../world/plots";
import { doingOf } from "../hud/rules";
import { useProjectNames } from "../../pages/issues/data";
import { FarmEmpty, FarmTag, FileRow, Said, tint, Tinted } from "./bits";

type Answer = { ok: boolean; text: string };

const stateTone: Record<GraphState, [fill: string, ink: string]> = {
  splitting: ["#d5dcd7", "#46301d"],
  draft: ["#efd08f", "#2f1f13"],
  running: ["#74a046", "#f7e8c4"],
  paused: ["#c8a46e", "#46301d"],
  ripe: ["#e5a93c", "#2f1f13"],
  done: ["#e2c995", "#67482d"],
  abandoned: ["#e2c995", "#7f5b3b"],
};

const isOpen = (g: TaskGraph) => g.state !== "done" && g.state !== "abandoned";
const taskOf = (g: TaskGraph, id: string) => g.tasks.find((n) => n.id === id);
const actionText = (g: TaskGraph, a: GraphAction) => g.actionText?.[a] ?? "";

const StateTag = ({ g }: { g: TaskGraph }) => <FarmTag text={g.stateTag ?? ""} fill={stateTone[g.state][0]} ink={stateTone[g.state][1]} />;

export function TaskBoard() {
  const { frame } = useFrames();
  const shown = useFarm((s) => s.graphShown);
  const [creating, setCreating] = useState(false);
  const list = [...(frame?.graphs ?? [])].reverse();
  const current = list.find((g) => g.id === shown) ?? list.find(isOpen) ?? list[0];
  if (creating || !current)
    return (
      <NewTask
        onCancel={current ? () => setCreating(false) : undefined}
        onSplit={(id) => {
          setCreating(false);
          farm.showGraph(id);
        }}
      />
    );
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="种植计划">
        {list.map((g) => (
          <button
            key={g.id}
            type="button"
            aria-pressed={g.id === current.id}
            onClick={() => farm.showGraph(g.id)}
            className="flex max-w-56 cursor-pointer items-center gap-1.5 py-1 pr-1 pl-3"
            style={{ background: g.id === current.id ? tint("#b4cb7c", 0.7) : "#e2c995" }}
          >
            <span className="truncate text-[12px]">{g.title}</span>
            <StateTag g={g} />
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex cursor-pointer items-center gap-1 bg-cream-200 px-3 py-1 text-[12px] text-leaf-700 hover:bg-cream-300"
        >
          <SpriteIcon name="button-add" size={12} />
          新计划
        </button>
      </div>
      <div className="mt-3">
        <TaskView key={current.id} graph={current} />
      </div>
    </div>
  );
}

function NewTask({ onCancel, onSplit }: { onCancel?: () => void; onSplit: (id: string) => void }) {
  const core = useCore();
  const { frame } = useFrames();
  const real = useProjectNames();
  const agents = useWorkAgents().filter((a) => a.enabled);
  const commands = useFarmCommands();
  const [goal, setGoal] = useState("");
  const [project, setProject] = useState<string>();
  const [splitter, setSplitter] = useState("auto");
  const [said, setSaid] = useState<Answer>();
  const [busy, setBusy] = useState(false);
  const known = [
    ...new Set([...real, ...(core?.sessions ?? []).flatMap((s) => (s.project ? [s.project] : [])), ...(frame?.graphs ?? []).map((g) => g.project)]),
  ];
  const where = project ?? known[0] ?? "";
  const ok = !busy && goal.trim() !== "" && where.trim() !== "";
  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    const answer = await commands.split({ goal, project: where, agent: splitter === "auto" ? undefined : splitter });
    setBusy(false);
    const id = /（(p\d+)）/.exec(answer.text)?.[1];
    if (answer.ok && id) onSplit(id);
    else setSaid(answer);
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-bark-900">
        一件很长的活：先派一个帮工读代码，把它拆成几步，每步交给一个帮工，有先后。拆好了你看过、改过再开工；每步做完合进计划自己的分支，全做完你再一次收进主分支。
      </p>
      <PxField label="要做什么">
        <PxTextArea value={goal} onChange={setGoal} rows={4} placeholder="比如：给 clock-in 加按月查询打卡记录，带一个页面，要有测试" />
      </PxField>
      <div className="flex gap-3">
        <div className="flex-1">
          <PxField label="在哪个项目">
            <PxTextInput value={where} onChange={setProject} placeholder="clock-in" suggestions={known} />
          </PxField>
        </div>
        <div className="flex-1">
          <PxField label="谁来拆">
            <PxPick
              value={splitter}
              placeholder="按规则挑"
              onChange={setSplitter}
              options={[{ value: "auto", label: "按规则挑" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
            />
          </PxField>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        {onCancel && <PxButton onClick={onCancel}>算了</PxButton>}
        <PxButton tone="primary" disabled={!ok} onClick={() => void submit()}>
          拆计划
        </PxButton>
      </div>
      <Said answer={said} />
    </div>
  );
}

function TaskView({ graph }: { graph: TaskGraph }) {
  const commands = useFarmCommands();
  const [said, setSaid] = useState<Answer>();
  const [reviewing, setReviewing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [only, setOnly] = useState<string>();
  const act = async (a: GraphAction) => setSaid(await commands.actOnGraph(graph.id, a));
  const settled = graph.settled ?? 0;
  const xs = "text-[12px] text-bark-600";
  return (
    <div className="flex flex-col">
      <Tinted className="p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px]">{graph.title}</span>
          <StateTag g={graph} />
          {graph.tasks.length > 0 && (
            <span className={xs}>
              {settled}/{graph.tasks.length} 步
            </span>
          )}
          {graph.spent && <span className={xs}>花了 {spentText(graph.spent)}</span>}
        </div>
        <p className="mt-1 text-[13px] text-bark-800">{graph.goal}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <FarmTag text={`项目 ${graph.project}`} fill="#a5743f" ink="#f7e8c4" />
          {graph.branch && <FarmTag text={graph.branch} />}
          {graph.state === "running" && <span className="text-[12px] text-bark-500">每步做完合进这条分支；收获时整条合进主分支</span>}
        </div>
        {graph.note && (
          <Tinted color={tint("#e5a93c", 0.25)} className="mt-2 px-2.5 py-1.5">
            <p className="text-[12px]">{graph.note}</p>
          </Tinted>
        )}
        {isOpen(graph) && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {graph.actions?.includes("start") && (
              <>
                <PxButton tone="primary" onClick={() => void act("start")}>
                  {actionText(graph, "start")}
                </PxButton>
                <PxButton icon="button-add" onClick={() => setAdding(true)}>
                  加一步
                </PxButton>
              </>
            )}
            {graph.actions?.includes("pause") && <PxButton onClick={() => void act("pause")}>{actionText(graph, "pause")}</PxButton>}
            {graph.state === "paused" && (
              <PxButton tone="primary" onClick={() => void act("resume")}>
                {actionText(graph, "resume")}
              </PxButton>
            )}
            {graph.state === "ripe" && (
              <PxButton tone="primary" onClick={() => setReviewing(true)}>
                看改动，{actionText(graph, "merge")}…
              </PxButton>
            )}
            {graph.actions?.includes("abandon") && (
              <Confirm label={`${actionText(graph, "abandon")}这个计划`} sure="确定放弃？分支会留着" onConfirm={() => void act("abandon")} />
            )}
          </div>
        )}
        <Said answer={said} />
      </Tinted>
      <div className="mt-3">
        {reviewing ? (
          <TaskHarvest
            graph={graph}
            onDone={(a) => {
              setReviewing(false);
              if (a) setSaid(a);
            }}
          />
        ) : graph.state === "splitting" ? (
          <FarmEmpty text="帮工在读代码、拆计划。拆好了会出现在这里，你看过再开工。" />
        ) : (
          <Steps graph={graph} adding={adding} onSaid={setSaid} onAdded={() => setAdding(false)} onHistory={setOnly} />
        )}
      </div>
      <TaskLog graph={graph} only={only} onAll={() => setOnly(undefined)} />
    </div>
  );
}

function Confirm({ label, sure, onConfirm }: { label: string; sure: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  return asking ? (
    <span className="flex gap-1.5">
      <PxButton tone="danger" onClick={onConfirm}>
        {sure}
      </PxButton>
      <PxButton onClick={() => setAsking(false)}>不了</PxButton>
    </span>
  ) : (
    <PxButton onClick={() => setAsking(true)}>{label}</PxButton>
  );
}

function TaskHarvest({ graph, onDone }: { graph: TaskGraph; onDone: (a?: Answer) => void }) {
  const commands = useFarmCommands();
  const changes = useQuery({ queryKey: ["issues", "graph-changes", graph.id], queryFn: () => api.graph.changes({ id: graph.id }) });
  if (changes.isPending) return <p className="py-10 text-center text-[13px] text-bark-600">正在看计划分支改了什么…</p>;
  if (changes.error)
    return (
      <div className="flex flex-col items-start gap-3">
        <Tinted color={tint("#c84a3a", 0.12)}>
          <p className="text-[13px] text-berry">看不了改动：{reasonOf(changes.error)}</p>
        </Tinted>
        <PxButton onClick={() => onDone()}>先不收</PxButton>
      </div>
    );
  const c = changes.data;
  const [added, removed] = lineCounts(c);
  const conflicts = new Set(c.conflicts);
  return (
    <div className="flex flex-col">
      <p className="text-[13px]">
        {c.branch ?? ""} → {c.project} 的 {c.base}：{c.commits.length} 个提交，{c.files.length} 个文件，<span className="text-leaf-700">+{added}</span>
        <span className="text-berry"> -{removed}</span>
        {c.behind > 0 && (
          <span className="text-bark-600">
            ；这期间 {c.base} 多了 {Math.round(c.behind)} 个提交
          </span>
        )}
      </p>
      {conflicts.size > 0 && (
        <Tinted color={tint("#c84a3a", 0.12)} className="mt-1">
          <p className="text-[13px] text-berry">
            合进 {c.base} 会冲突：{c.conflicts.join("、")}。先不收，等 {c.base} 上的改动处理好。
          </p>
        </Tinted>
      )}
      <FarmSection title="提交">
        {c.commits.map((x) => (
          <div key={x.hash} className="flex items-center gap-2">
            <span className="font-mono text-[12.5px] text-bark-500">{x.hash}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-bark-800">{x.subject}</span>
          </div>
        ))}
      </FarmSection>
      <FarmSection title="文件">
        <div className="flex flex-col gap-1">
          {c.files.map((f) => (
            <FileRow key={f.path} file={f} conflict={conflicts.has(f.path)} />
          ))}
        </div>
      </FarmSection>
      <div className="mt-3 flex justify-end gap-2">
        <PxButton onClick={() => onDone()}>先不收</PxButton>
        <PxButton tone="primary" disabled={conflicts.size > 0} onClick={() => void commands.actOnGraph(graph.id, "merge").then(onDone)}>
          确认收获，合进 {c.base}
        </PxButton>
      </div>
    </div>
  );
}

const nodeTone: Record<TaskState, { card: string; edge?: string; tag: string; ink: string; opacity: number }> = {
  waiting: { card: "#eedcb2", tag: "#e2c995", ink: "#2f1f13", opacity: 1 },
  working: { card: tint("#b4cb7c", 0.35), edge: "#74a046", tag: "#74a046", ink: "#f7e8c4", opacity: 1 },
  merged: { card: tint("#e5a93c", 0.2), tag: tint("#e5a93c", 0.6), ink: "#2f1f13", opacity: 1 },
  failed: { card: tint("#c84a3a", 0.1), edge: "#c84a3a80", tag: "#c84a3a", ink: "#f7e8c4", opacity: 1 },
  skipped: { card: "#eedcb2", tag: "#e2c995", ink: "#67482d", opacity: 0.6 },
};

function SmallBtn({ label, onClick, primary }: { label: string; onClick?: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      className={`px-2.5 py-0.5 text-[12px] enabled:cursor-pointer disabled:opacity-40 ${primary ? "bg-leaf-500 text-cream-50 enabled:hover:bg-leaf-600" : "bg-cream-50 text-bark-800 enabled:hover:bg-cream-200"}`}
    >
      {label}
    </button>
  );
}

function Steps({
  graph,
  adding,
  onSaid,
  onAdded,
  onHistory,
}: {
  graph: TaskGraph;
  adding: boolean;
  onSaid: (a: Answer) => void;
  onAdded: () => void;
  onHistory: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string>();
  if (graph.tasks.length === 0 && !adding) return <FarmEmpty text="计划里还没有步骤。" />;
  return (
    <div className="flex items-start overflow-x-auto pb-2">
      {(graph.layers ?? []).map((ids, i) => (
        <div key={i} className="flex items-start">
          {i > 0 && (
            <span aria-hidden className="px-2 pt-8 text-[16px] text-bark-400">
              →
            </span>
          )}
          <div className="flex w-60 shrink-0 flex-col gap-2" role="group" aria-label={i === 0 ? "先做" : `第 ${i + 1} 批`}>
            <span className="px-1 text-[12px] text-bark-500">{i === 0 ? "先做" : `第 ${i + 1} 批`}</span>
            {ids.map((id) => {
              const node = taskOf(graph, id);
              if (!node) return null;
              return editing === id ? (
                <NodeEditor
                  key={id}
                  graph={graph}
                  node={node}
                  onDone={(a) => {
                    setEditing(undefined);
                    if (a) onSaid(a);
                  }}
                />
              ) : (
                <NodeCard key={id} graph={graph} node={node} onEdit={() => setEditing(id)} onSaid={onSaid} onHistory={() => onHistory(id)} />
              );
            })}
          </div>
        </div>
      ))}
      {adding && (
        <div className="ml-2 w-64 shrink-0">
          <NodeEditor
            graph={graph}
            onDone={(a) => {
              onAdded();
              if (a) onSaid(a);
            }}
          />
        </div>
      )}
    </div>
  );
}

function NodeCard({
  graph,
  node,
  onEdit,
  onSaid,
  onHistory,
}: {
  graph: TaskGraph;
  node: Task;
  onEdit: () => void;
  onSaid: (a: Answer) => void;
  onHistory: () => void;
}) {
  const agents = new Map((useAgents().data ?? []).map((a) => [a.id, a]));
  const core = useCore();
  const commands = useFarmCommands();
  const agent = node.agent ? agents.get(node.agent) : undefined;
  const session: Session | undefined = node.session ? core?.sessions.find((s) => s.id === node.session) : undefined;
  const titleOf = (id: string) => taskOf(graph, id)?.title ?? id;
  const waits = node.state === "waiting" ? (node.blockedBy ?? []) : [];
  const doing = session ? doingOf(session) : undefined;
  const nodeAct = async (a: "retry" | "skip") => onSaid(await commands.actOnTask(graph.id, node.id, a));
  const tone = nodeTone[node.state];
  return (
    <div className="flex flex-col p-2.5" style={{ background: tone.card, border: `1.5px solid ${tone.edge ?? "transparent"}`, opacity: tone.opacity }}>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px]" title={node.title}>
          {node.title}
        </span>
        {node.acceptance && (
          <span title={node.frozen?.length ? `验收，冻结了：${node.frozen.join("、")}` : "验收：写好时要不通过，最后一步让它通过"}>
            <FarmTag text="验收" fill="#5c7a3a" ink="#f7e8c4" />
          </span>
        )}
        <FarmTag text={node.stateText ?? ""} fill={tone.tag} ink={tone.ink} />
      </div>
      <p className="mt-1 line-clamp-4 text-[12px] text-bark-800" title={node.brief}>
        {node.brief}
      </p>
      <div className="mt-1.5 flex items-center gap-1">
        {agent && <AgentFace agentId={agent.id} look={agent.look} size={18} />}
        <span className="text-[12px] text-bark-600">{agent?.name ?? "按规则挑"}</span>
        {node.check && (
          <span title={`做完跑 ${node.check}`} className="ml-auto truncate bg-cream-50/80 px-1 font-mono text-[10px] text-bark-900">
            {node.check}
          </span>
        )}
      </div>
      {node.needs.length > 0 && (
        <p className="mt-1 text-[12px] text-bark-600">
          {waits.length ? `等 ${waits.map(titleOf).join("、")}` : `接在 ${node.needs.map(titleOf).join("、")} 后面`}
        </p>
      )}
      {session && (
        <p className="mt-1.5 bg-cream-50/70 px-1.5 py-1 text-[12px] text-bark-800">
          {session.name} · 第 {stationOfSession(session) + 1} 块地{doing && doing.action !== "none" ? ` · 在${doing.actionText ?? ""}` : ""}
        </p>
      )}
      {node.conclusion && (
        <p className={`mt-1.5 line-clamp-4 text-[12px] ${node.state === "failed" ? "text-berry" : "text-bark-800"}`} title={node.conclusion}>
          {node.conclusion}
        </p>
      )}
      {(node.commits ?? []).length > 0 && <p className="mt-1 truncate font-mono text-[10px] text-bark-500">{node.commits!.join(" ")}</p>}
      {node.spent && <p className="text-[10px] text-bark-500">{spentText(node.spent)}</p>}
      <div className="mt-2 flex flex-wrap gap-1">
        {node.actions?.includes("retry") && <SmallBtn label={node.actionText?.retry ?? ""} onClick={() => void nodeAct("retry")} />}
        {node.actions?.includes("skip") && <SmallBtn label={node.actionText?.skip ?? ""} onClick={() => void nodeAct("skip")} />}
        {node.canEdit && <SmallBtn label="改" onClick={onEdit} />}
        {node.canRemove && <SmallBtn label="删" onClick={() => void commands.removeTask(graph.id, node.id).then(onSaid)} />}
        <SmallBtn label="经过" onClick={onHistory} />
      </div>
    </div>
  );
}

function NodeEditor({ graph, node, onDone }: { graph: TaskGraph; node?: Task; onDone: (a?: Answer) => void }) {
  const agents = useWorkAgents().filter((a) => a.enabled);
  const commands = useFarmCommands();
  const [id, setId] = useState(node?.id ?? "");
  const [title, setTitle] = useState(node?.title ?? "");
  const [brief, setBrief] = useState(node?.brief ?? "");
  const [agent, setAgent] = useState(node?.agent ?? "");
  const [check, setCheck] = useState(node?.check ?? "");
  const [needs, setNeeds] = useState<string[]>(node?.needs ?? []);
  const [problem, setProblem] = useState("");
  const others = graph.tasks.filter((n) => n.id !== (node?.id ?? id));
  const ready = id.trim() !== "" && brief.trim() !== "";
  const save = async () => {
    if (!ready) return;
    const a = await commands.editTask(graph.id, id.trim(), { title, brief, agent, check, needs });
    if (a.ok) onDone(a);
    else setProblem(a.text);
  };
  return (
    <div className="flex flex-col gap-1.5 border-[1.5px] border-leaf-500 bg-cream-100 p-2.5">
      {!node && <PxTextInput value={id} onChange={setId} placeholder="步骤 id，比如 docs" label="步骤 id" mono />}
      <PxTextInput value={title} onChange={setTitle} placeholder="标题" label="标题" />
      <PxTextArea value={brief} onChange={setBrief} rows={5} placeholder="工单：目标、改哪里、做到什么程度算完" label="工单" />
      <PxPick
        value={agent}
        placeholder="谁来做：按规则挑"
        clearable
        label="谁来做"
        onChange={setAgent}
        options={agents.map((a) => ({ value: a.id, label: a.name }))}
      />
      <PxTextInput value={check} onChange={setCheck} placeholder="做完跑的检查，比如 pnpm test（可空）" label="检查命令" mono />
      {others.length > 0 && (
        <>
          <span className="text-[12px] text-bark-600">等这些做完：</span>
          <div className="flex flex-wrap gap-1">
            {others.map((n) => {
              const on = needs.includes(n.id);
              return (
                <button
                  key={n.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setNeeds(on ? needs.filter((x) => x !== n.id) : [...needs, n.id])}
                  className={`cursor-pointer px-2 py-0.5 text-[12px] ${on ? "bg-leaf-500 text-cream-50" : "bg-cream-50 text-bark-800 hover:bg-cream-200"}`}
                >
                  {n.title}
                </button>
              );
            })}
          </div>
        </>
      )}
      {problem && <p className="text-[12px] text-berry">{problem}</p>}
      <div className="flex justify-end gap-1">
        <SmallBtn label="算了" onClick={() => onDone()} />
        <SmallBtn label={node ? "改好了" : "加上"} primary onClick={ready ? () => void save() : undefined} />
      </div>
    </div>
  );
}

const actorTone: Record<GraphEvent["actor"], [fill: string, ink: string]> = {
  user: ["#74a046", "#f7e8c4"],
  manager: ["#efd08f", "#2f1f13"],
  session: ["#bfd7ea", "#2f1f13"],
  system: ["#e2c995", "#2f1f13"],
};

const when = (at: number) => {
  const d = new Date(Math.round(at));
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function TaskLog({ graph, only, onAll }: { graph: TaskGraph; only?: string; onAll: () => void }) {
  // Read when shown, and again whenever the graph changes: something happened.
  const events = useQuery({ queryKey: ["graph-events", graph.id, graph], queryFn: () => api.graph.events({ id: graph.id }) }).data;
  const titleOf = (id: string) => taskOf(graph, id)?.title ?? id;
  const shown = (events ?? []).filter((e) => !only || e.task === only).reverse();
  return (
    <FarmSection title={only ? `「${titleOf(only)}」的经过` : "经过"}>
      {only && (
        <button
          type="button"
          onClick={onAll}
          className="mb-2 cursor-pointer self-start bg-cream-200 px-2.5 py-0.5 text-[12px] text-bark-800 hover:bg-cream-300"
        >
          看整个计划的经过
        </button>
      )}
      {shown.length === 0 ? (
        <p className="text-[13px] text-bark-600">{events ? "还没有记下什么。" : "正在读…"}</p>
      ) : (
        <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
          {shown.map((e) => (
            <LogRow key={e.id} e={e} />
          ))}
        </div>
      )}
    </FarmSection>
  );
}

function LogRow({ e }: { e: GraphEvent }) {
  const [open, setOpen] = useState(false);
  const [fill, ink] = actorTone[e.actor];
  const changes = e.changes ?? [];
  return (
    <div className="flex items-start gap-2">
      <span className="w-[88px] shrink-0 text-[12px] text-bark-400">{when(e.at)}</span>
      <span className="w-11 shrink-0 py-0.5 text-center text-[10px]" style={{ background: fill, color: ink }}>
        {e.actorText ?? ""}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-bark-800">{e.text ?? ""}</p>
        {changes.length > 0 && (
          <>
            <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 cursor-pointer text-[12px] text-bark-600">
              改前改后
            </button>
            {open &&
              changes.map((c) => (
                <div key={c.field} className="mt-1 text-[12px] text-bark-600">
                  <p>{c.field}</p>
                  <p>
                    <span className="text-berry line-through">{c.from || "（空）"}</span> → <span className="text-leaf-700">{c.to || "（空）"}</span>
                  </p>
                </div>
              ))}
          </>
        )}
      </div>
    </div>
  );
}
