import { list, t } from "@vibevalley/i18n";
// 种植计划: the task graphs, a new one split by a helper, and the one shown: its state and actions, its steps in batches
// (each with who does it, what it waits on, what it concluded, and retry, skip, edit, remove, its history), its
// harvest, and the log of what happened. The words of the states and actions are the server's (stateTag, stateText,
// actionText).

import { spentText } from "@/base/format";
import { createMemo, createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import { type GraphAction, type GraphEvent, type GraphState, type Task, type TaskGraph, type TaskState } from "@vibevalley/protocol";
import { api, reasonOf } from "@/base/api";
import { doingOf } from "@/farm/hud/rules";
import { farm } from "@/farm/store";
import { stationOfSession } from "@/farm/world/plots";
import { lineCounts } from "@/features/issue";
import { aria, Keyed } from "@/base/util";
import { useCore, useFrames } from "@/base/frame";
import { ready, useProjects, useQuery } from "@/base/query";
import { AgentFace } from "@/ui/Face";
import { FarmSection, PxButton, PxField, PxPick, PxTextArea, PxTextInput, SpriteIcon } from "@/ui/pixel";
import { useFarm } from "@/farm/state";
import { FarmEmpty, FarmTag, FileRow, Said, tint, Tinted } from "./bits";
import { type Answer, graphs, useGraphChanges } from "@/features/task";
import { useAgent, useWorkAgents } from "@/base/agents";
import { omitUndefined } from "@vibevalley/protocol/rules";

const stateTone: Record<GraphState, [fill: string, ink: string]> = {
  splitting: ["#d5dcd7", "#46301d"],
  draft: ["#efd08f", "#2f1f13"],
  running: ["#74a046", "#f7e8c4"],
  paused: ["#c8a46e", "#46301d"],
  ready: ["#e5a93c", "#2f1f13"],
  done: ["#e2c995", "#67482d"],
  abandoned: ["#e2c995", "#7f5b3b"],
};

const isOpen = (g: TaskGraph) => g.state !== "done" && g.state !== "abandoned";
const taskOf = (g: TaskGraph, id: string) => g.tasks.find((n) => n.id === id);
const actionText = (g: TaskGraph, a: GraphAction) => g.actionText[a] ?? "";

const StateTag = (props: { g: TaskGraph }) => <FarmTag text={props.g.stateTag} fill={stateTone[props.g.state][0]} ink={stateTone[props.g.state][1]} />;

export function TaskBoard() {
  const frames = useFrames();
  const shown = useFarm((s) => s.graphShown);
  const [creating, setCreating] = createSignal(false);
  const list = () => [...(frames.frame?.graphs ?? [])].reverse();
  const current = createMemo(() => list().find((g) => g.id === shown()) ?? list().find(isOpen) ?? list()[0]);
  return (
    <Show
      when={!creating() && current()}
      fallback={
        <NewTask
          onCancel={current() ? () => setCreating(false) : undefined}
          onSplit={(id) => {
            setCreating(false);
            farm.showGraph(id);
          }}
        />
      }
    >
      {(g) => (
        <div class="flex flex-col">
          <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("web.farm.graph.name")}>
            <For each={list()}>
              {(item) => (
                <button
                  type="button"
                  aria-pressed={aria(item.id === g().id)}
                  onClick={() => farm.showGraph(item.id)}
                  class="flex max-w-56 cursor-pointer items-center gap-1.5 py-1 pr-1 pl-3"
                  style={{ background: item.id === g().id ? tint("#b4cb7c", 0.7) : "#e2c995" }}
                >
                  <span class="truncate text-[12px]">{item.title}</span>
                  <StateTag g={item} />
                </button>
              )}
            </For>
            <button
              type="button"
              onClick={() => setCreating(true)}
              class="flex cursor-pointer items-center gap-1 bg-cream-200 px-3 py-1 text-[12px] text-leaf-700 hover:bg-cream-300"
            >
              <SpriteIcon name="button-add" size={12} />
              {t("web.farm.graph.new")}
            </button>
          </div>
          <div class="mt-3">
            <Keyed key={g().id}>{() => <TaskView graph={g()} />}</Keyed>
          </div>
        </div>
      )}
    </Show>
  );
}

function NewTask(props: { onCancel?: (() => void) | undefined; onSplit: (id: string) => void }) {
  const core = useCore();
  const frames = useFrames();
  const projectsQuery = useProjects();
  const agents = useWorkAgents(true);
  const [goal, setGoal] = createSignal("");
  const [project, setProject] = createSignal<string>();
  const [splitter, setSplitter] = createSignal("auto");
  const [said, setSaid] = createSignal<Answer>();
  const [busy, setBusy] = createSignal(false);
  const known = () => [
    ...new Set([
      ...ready(projectsQuery, []).map((p) => p.name),
      ...(core()?.sessions ?? []).flatMap((s) => (s.project ? [s.project] : [])),
      ...(frames.frame?.graphs ?? []).map((g) => g.project),
    ]),
  ];
  const where = () => project() ?? known()[0] ?? "";
  const ok = () => !busy() && goal().trim() !== "" && where().trim() !== "";
  const submit = async () => {
    if (!ok()) return;
    setBusy(true);
    const answer = await graphs.split(omitUndefined({ goal: goal(), project: where(), agent: splitter() === "auto" ? undefined : splitter() }));
    setBusy(false);
    const id = /（(p\d+)）/.exec(answer.text)?.[1];
    if (answer.ok && id) props.onSplit(id);
    else setSaid(answer);
  };
  return (
    <div class="flex flex-col gap-3">
      <p class="text-[13px] text-bark-900">{t("web.farm.graph.intro")}</p>
      <PxField label={t("web.farm.graph.goal")}>
        <PxTextArea value={goal()} onChange={setGoal} rows={4} placeholder={t("web.farm.graph.goalExample")} />
      </PxField>
      <div class="flex gap-3">
        <div class="flex-1">
          <PxField label={t("web.farm.graph.project")}>
            <PxTextInput value={where()} onChange={setProject} placeholder={t("web.base.form.example", { value: "clock-in" })} suggestions={known()} />
          </PxField>
        </div>
        <div class="flex-1">
          <PxField label={t("web.farm.graph.splitter")}>
            <PxPick
              value={splitter()}
              placeholder={t("web.farm.graph.byRule")}
              onChange={setSplitter}
              options={[{ value: "auto", label: t("web.farm.graph.byRule") }, ...agents().map((a) => ({ value: a.id, label: a.name }))]}
            />
          </PxField>
        </div>
      </div>
      <div class="flex justify-end gap-2">
        <Show when={props.onCancel}>
          <PxButton onClick={() => props.onCancel?.()}>{t("web.farm.never")}</PxButton>
        </Show>
        <PxButton tone="primary" disabled={!ok()} onClick={() => void submit()}>
          {t("web.farm.graph.split")}
        </PxButton>
      </div>
      <Said answer={said()} />
    </div>
  );
}

function TaskView(props: { graph: TaskGraph }) {
  const [said, setSaid] = createSignal<Answer>();
  const [reviewing, setReviewing] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const [only, setOnly] = createSignal<string>();
  const act = async (a: GraphAction) => setSaid(await graphs.act(props.graph.id, a));
  const settled = () => props.graph.settled ?? 0;
  const xs = "text-[12px] text-bark-600";
  return (
    <div class="flex flex-col">
      <Tinted class="p-3">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="text-[13px]">{props.graph.title}</span>
          <StateTag g={props.graph} />
          <Show when={props.graph.tasks.length > 0}>
            <span class={xs}>{t("web.farm.graph.steps", { done: settled(), of: props.graph.tasks.length })}</span>
          </Show>
          <Show when={props.graph.spent}>{(spent) => <span class={xs}>{t("web.farm.graph.spent", { spent: spentText(spent()) })}</span>}</Show>
        </div>
        <p class="mt-1 text-[13px] text-bark-800">{props.graph.goal}</p>
        <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
          <FarmTag text={t("web.farm.graph.projectTag", { project: props.graph.project })} fill="#a5743f" ink="#f7e8c4" />
          <Show when={props.graph.branch}>
            <FarmTag text={props.graph.branch!} />
          </Show>
          <Show when={props.graph.state === "running"}>
            <span class="text-[12px] text-bark-500">{t("web.farm.graph.running")}</span>
          </Show>
        </div>
        <Show when={props.graph.note}>
          <Tinted color={tint("#e5a93c", 0.25)} class="mt-2 px-2.5 py-1.5">
            <p class="text-[12px]">{props.graph.note}</p>
          </Tinted>
        </Show>
        <Show when={isOpen(props.graph)}>
          <div class="mt-2.5 flex flex-wrap gap-2">
            <Show when={props.graph.actions.includes("start")}>
              <PxButton tone="primary" onClick={() => void act("start")}>
                {actionText(props.graph, "start")}
              </PxButton>
              <PxButton icon="button-add" onClick={() => setAdding(true)}>
                {t("web.farm.graph.addStep")}
              </PxButton>
            </Show>
            <Show when={props.graph.actions.includes("pause")}>
              <PxButton onClick={() => void act("pause")}>{actionText(props.graph, "pause")}</PxButton>
            </Show>
            <Show when={props.graph.state === "paused"}>
              <PxButton tone="primary" onClick={() => void act("resume")}>
                {actionText(props.graph, "resume")}
              </PxButton>
            </Show>
            <Show when={props.graph.state === "ready"}>
              <PxButton tone="primary" onClick={() => setReviewing(true)}>
                {t("web.farm.graph.review", { merge: actionText(props.graph, "merge") })}
              </PxButton>
            </Show>
            <Show when={props.graph.actions.includes("abandon")}>
              <Confirm
                label={t("web.farm.graph.abandon", { abandon: actionText(props.graph, "abandon") })}
                sure={t("web.farm.graph.abandonSure")}
                onConfirm={() => void act("abandon")}
              />
            </Show>
          </div>
        </Show>
        <Said answer={said()} />
      </Tinted>
      <div class="mt-3">
        <Switch fallback={<Steps graph={props.graph} adding={adding()} onSaid={setSaid} onAdded={() => setAdding(false)} onHistory={setOnly} />}>
          <Match when={reviewing()}>
            <TaskHarvest
              graph={props.graph}
              onDone={(a) => {
                setReviewing(false);
                if (a) setSaid(a);
              }}
            />
          </Match>
          <Match when={props.graph.state === "splitting"}>
            <FarmEmpty text={t("web.farm.graph.splitting")} />
          </Match>
        </Switch>
      </div>
      <TaskLog graph={props.graph} only={only()} onAll={() => setOnly(undefined)} />
    </div>
  );
}

function Confirm(props: { label: string; sure: string; onConfirm: () => void }) {
  const [asking, setAsking] = createSignal(false);
  return (
    <Show when={asking()} fallback={<PxButton onClick={() => setAsking(true)}>{props.label}</PxButton>}>
      <span class="flex gap-1.5">
        <PxButton tone="danger" onClick={() => props.onConfirm()}>
          {props.sure}
        </PxButton>
        <PxButton onClick={() => setAsking(false)}>{t("web.farm.graph.no")}</PxButton>
      </span>
    </Show>
  );
}

function TaskHarvest(props: { graph: TaskGraph; onDone: (a?: Answer) => void }) {
  const changes = useGraphChanges(() => props.graph.id);
  return (
    <Switch fallback={<p class="py-10 text-center text-[13px] text-bark-600">{t("web.farm.graph.readingChanges")}</p>}>
      <Match when={changes.error}>
        {(error) => (
          <div class="flex flex-col items-start gap-3">
            <Tinted color={tint("#c84a3a", 0.12)}>
              <p class="text-[13px] text-berry">
                {t("web.farm.graph.unreadable")}
                {reasonOf(error())}
              </p>
            </Tinted>
            <PxButton onClick={() => props.onDone()}>{t("web.farm.notNow")}</PxButton>
          </div>
        )}
      </Match>
      <Match when={changes.isSuccess ? changes.data : undefined}>
        {(c) => {
          const counts = () => lineCounts(c());
          const conflicts = () => new Set(c().conflicts);
          return (
            <div class="flex flex-col">
              <p class="text-[13px]">
                {t("web.farm.graph.summary", {
                  branch: c().branch ?? "",
                  project: c().project,
                  base: c().base,
                  commits: c().commits.length,
                  files: c().files.length,
                })}
                <span class="text-leaf-700">+{counts()[0]}</span>
                <span class="text-berry"> -{counts()[1]}</span>
                <Show when={c().behind > 0}>
                  <span class="text-bark-600">{t("web.farm.graph.behind", { base: c().base, n: Math.round(c().behind) })}</span>
                </Show>
              </p>
              <Show when={conflicts().size > 0}>
                <Tinted color={tint("#c84a3a", 0.12)} class="mt-1">
                  <p class="text-[13px] text-berry">{t("web.farm.graph.conflict", { base: c().base, files: list(c().conflicts) })}</p>
                </Tinted>
              </Show>
              <FarmSection title={t("web.farm.graph.commits")}>
                <For each={c().commits}>
                  {(x) => (
                    <div class="flex items-center gap-2">
                      <span class="font-mono text-[12.5px] text-bark-500">{x.hash}</span>
                      <span class="min-w-0 flex-1 truncate text-[12px] text-bark-800">{x.subject}</span>
                    </div>
                  )}
                </For>
              </FarmSection>
              <FarmSection title={t("web.farm.graph.files")}>
                <div class="flex flex-col gap-1">
                  <For each={c().files}>{(f) => <FileRow file={f} conflict={conflicts().has(f.path)} />}</For>
                </div>
              </FarmSection>
              <div class="mt-3 flex justify-end gap-2">
                <PxButton onClick={() => props.onDone()}>{t("web.farm.notNow")}</PxButton>
                <PxButton tone="primary" disabled={conflicts().size > 0} onClick={() => void graphs.act(props.graph.id, "merge").then((a) => props.onDone(a))}>
                  {t("web.farm.graph.harvest", { base: c().base })}
                </PxButton>
              </div>
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}

const nodeTone: Record<TaskState, { card: string; edge?: string; tag: string; ink: string; opacity: number }> = {
  waiting: { card: "#eedcb2", tag: "#e2c995", ink: "#2f1f13", opacity: 1 },
  working: { card: tint("#b4cb7c", 0.35), edge: "#74a046", tag: "#74a046", ink: "#f7e8c4", opacity: 1 },
  merged: { card: tint("#e5a93c", 0.2), tag: tint("#e5a93c", 0.6), ink: "#2f1f13", opacity: 1 },
  failed: { card: tint("#c84a3a", 0.1), edge: "#c84a3a80", tag: "#c84a3a", ink: "#f7e8c4", opacity: 1 },
  skipped: { card: "#eedcb2", tag: "#e2c995", ink: "#67482d", opacity: 0.6 },
};

function SmallBtn(props: { label: string; onClick?: (() => void) | undefined; primary?: boolean }) {
  return (
    <button
      type="button"
      disabled={!props.onClick}
      onClick={() => props.onClick?.()}
      class={[
        "px-2.5 py-0.5 text-[12px] enabled:cursor-pointer disabled:opacity-40",
        props.primary ? "bg-leaf-500 text-bark-900 enabled:hover:bg-leaf-hover" : "bg-cream-50 text-bark-800 enabled:hover:bg-cream-200",
      ]}
    >
      {props.label}
    </button>
  );
}

function Steps(props: { graph: TaskGraph; adding: boolean; onSaid: (a: Answer) => void; onAdded: () => void; onHistory: (id: string) => void }) {
  const [editing, setEditing] = createSignal<string>();
  return (
    <Show when={props.graph.tasks.length > 0 || props.adding} fallback={<FarmEmpty text={t("web.farm.graph.noSteps")} />}>
      <div class="flex items-start overflow-x-auto pb-2">
        <For each={props.graph.layers} keyed={false}>
          {(ids, i) => (
            <div class="flex items-start">
              <Show when={i > 0}>
                <span aria-hidden="true" class="px-2 pt-8 text-[16px] text-bark-400">
                  →
                </span>
              </Show>
              <div
                class="flex w-60 shrink-0 flex-col gap-2"
                role="group"
                aria-label={i === 0 ? t("web.farm.graph.first") : t("web.farm.graph.batch", { n: i + 1 })}
              >
                <span class="px-1 text-[12px] text-bark-500">{i === 0 ? t("web.farm.graph.first") : t("web.farm.graph.batch", { n: i + 1 })}</span>
                <For each={ids()}>
                  {(id) => (
                    <Show when={taskOf(props.graph, id)}>
                      {(node) => (
                        <Show
                          when={editing() === id}
                          fallback={
                            <NodeCard
                              graph={props.graph}
                              node={node()}
                              onEdit={() => setEditing(id)}
                              onSaid={props.onSaid}
                              onHistory={() => props.onHistory(id)}
                            />
                          }
                        >
                          <NodeEditor
                            graph={props.graph}
                            node={node()}
                            onDone={(a) => {
                              setEditing(undefined);
                              if (a) props.onSaid(a);
                            }}
                          />
                        </Show>
                      )}
                    </Show>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
        <Show when={props.adding}>
          <div class="ml-2 w-64 shrink-0">
            <NodeEditor
              graph={props.graph}
              onDone={(a) => {
                props.onAdded();
                if (a) props.onSaid(a);
              }}
            />
          </div>
        </Show>
      </div>
    </Show>
  );
}

function NodeCard(props: { graph: TaskGraph; node: Task; onEdit: () => void; onSaid: (a: Answer) => void; onHistory: () => void }) {
  const core = useCore();
  const agent = useAgent(() => props.node.agent);
  const session = () => (props.node.session ? core()?.sessions.find((s) => s.id === props.node.session) : undefined);
  const titleOf = (id: string) => taskOf(props.graph, id)?.title ?? id;
  const waits = () => (props.node.state === "waiting" ? props.node.blockedBy : []);
  const doing = () => {
    const s = session();
    return s ? doingOf(s) : undefined;
  };
  const nodeAct = async (a: "retry" | "skip") => props.onSaid(await graphs.taskAct(props.graph.id, props.node.id, a));
  const tone = () => nodeTone[props.node.state];
  return (
    <div class="flex flex-col p-2.5" style={{ background: tone().card, border: `1.5px solid ${tone().edge ?? "transparent"}`, opacity: tone().opacity }}>
      <div class="flex items-center gap-1.5">
        <span class="min-w-0 flex-1 truncate text-[13px]" title={props.node.title}>
          {props.node.title}
        </span>
        <Show when={props.node.acceptance}>
          <span title={props.node.frozen.length ? t("web.farm.graph.frozen", { files: list(props.node.frozen) }) : t("web.farm.graph.acceptanceHint")}>
            <FarmTag text={t("web.farm.plot.review")} fill="#5c7a3a" ink="#f7e8c4" />
          </span>
        </Show>
        <FarmTag text={props.node.stateText} fill={tone().tag} ink={tone().ink} />
      </div>
      <p class="mt-1 line-clamp-4 text-[12px] text-bark-800" title={props.node.brief}>
        {props.node.brief}
      </p>
      <div class="mt-1.5 flex items-center gap-1">
        <Show when={agent()}>{(a) => <AgentFace agentId={a().id} runtime={session()?.runtime ?? a().runtime} look={a().look} size={18} />}</Show>
        <span class="text-[12px] text-bark-600">{agent()?.name ?? t("web.farm.graph.byRule")}</span>
        <Show when={props.node.check}>
          <span
            title={t("web.farm.graph.checkHint", { check: props.node.check ?? "" })}
            class="ml-auto truncate bg-cream-50/80 px-1 font-mono text-[10px] text-bark-900"
          >
            {props.node.check}
          </span>
        </Show>
      </div>
      <Show when={props.node.needs.length > 0}>
        <p class="mt-1 text-[12px] text-bark-600">
          {waits().length
            ? t("web.farm.graph.waits", { titles: list(waits().map(titleOf)) })
            : t("web.farm.graph.after", { titles: list(props.node.needs.map(titleOf)) })}
        </p>
      </Show>
      <Show when={session()}>
        {(s) => (
          <p class="mt-1.5 bg-cream-50/70 px-1.5 py-1 text-[12px] text-bark-800">
            {doing() && doing()!.action !== "none"
              ? t("web.farm.graph.onPlotDoing", { name: s().name, plot: stationOfSession(s()) + 1, doing: doing()!.actionText })
              : t("web.farm.graph.onPlot", { name: s().name, plot: stationOfSession(s()) + 1 })}
          </p>
        )}
      </Show>
      <Show when={props.node.conclusion}>
        <p class={["mt-1.5 line-clamp-4 text-[12px]", props.node.state === "failed" ? "text-berry" : "text-bark-800"]} title={props.node.conclusion}>
          {props.node.conclusion}
        </p>
      </Show>
      <Show when={props.node.commits.length > 0}>
        <p class="mt-1 truncate font-mono text-[10px] text-bark-500">{props.node.commits.join(" ")}</p>
      </Show>
      <Show when={props.node.spent}>{(spent) => <p class="text-[10px] text-bark-500">{spentText(spent())}</p>}</Show>
      <div class="mt-2 flex flex-wrap gap-1">
        <Show when={props.node.actions.includes("retry")}>
          <SmallBtn label={props.node.actionText.retry ?? ""} onClick={() => void nodeAct("retry")} />
        </Show>
        <Show when={props.node.actions.includes("skip")}>
          <SmallBtn label={props.node.actionText.skip ?? ""} onClick={() => void nodeAct("skip")} />
        </Show>
        <Show when={props.node.canEdit}>
          <SmallBtn label={t("web.farm.graph.edit")} onClick={() => props.onEdit()} />
        </Show>
        <Show when={props.node.canRemove}>
          <SmallBtn label={t("web.farm.graph.remove")} onClick={() => void graphs.removeTask(props.graph.id, props.node.id).then((a) => props.onSaid(a))} />
        </Show>
        <SmallBtn label={t("web.farm.graph.story")} onClick={() => props.onHistory()} />
      </div>
    </div>
  );
}

function NodeEditor(props: { graph: TaskGraph; node?: Task; onDone: (a?: Answer) => void }) {
  const agents = useWorkAgents(true);
  // The editor starts from the step as it is when opened, and edits its own copy.
  const start = untrack(() => props.node);
  const [id, setId] = createSignal(start?.id ?? "");
  const [title, setTitle] = createSignal(start?.title ?? "");
  const [brief, setBrief] = createSignal(start?.brief ?? "");
  const [agent, setAgent] = createSignal(start?.agent ?? "");
  const [check, setCheck] = createSignal(start?.check ?? "");
  const [needs, setNeeds] = createSignal<string[]>(start?.needs ? [...start.needs] : []);
  const [problem, setProblem] = createSignal("");
  const others = () => props.graph.tasks.filter((n) => n.id !== (props.node?.id ?? id()));
  const isReady = () => id().trim() !== "" && brief().trim() !== "";
  const save = async () => {
    if (!isReady()) return;
    const a = await graphs.editTask(props.graph.id, id().trim(), { title: title(), brief: brief(), agent: agent(), check: check(), needs: needs() });
    if (a.ok) props.onDone(a);
    else setProblem(a.text);
  };
  return (
    <div class="flex flex-col gap-1.5 border-[1.5px] border-leaf-500 bg-cream-100 p-2.5">
      <Show when={!props.node}>
        <PxTextInput value={id()} onChange={setId} placeholder={t("web.farm.graph.stepIdHint")} label={t("web.farm.graph.stepId")} mono />
      </Show>
      <PxTextInput value={title()} onChange={setTitle} placeholder={t("web.farm.graph.title")} label={t("web.farm.graph.title")} />
      <PxTextArea value={brief()} onChange={setBrief} rows={5} placeholder={t("web.farm.graph.briefHint")} label={t("web.farm.graph.brief")} />
      <PxPick
        value={agent()}
        placeholder={t("web.farm.graph.whoHint")}
        clearable
        label={t("web.farm.graph.who")}
        onChange={setAgent}
        options={agents().map((a) => ({ value: a.id, label: a.name }))}
      />
      <PxTextInput value={check()} onChange={setCheck} placeholder={t("web.farm.graph.checkExample")} label={t("web.farm.graph.check")} mono />
      <Show when={others().length > 0}>
        <span class="text-[12px] text-bark-600">{t("web.farm.graph.waitFor")}</span>
        <div class="flex flex-wrap gap-1">
          <For each={others()}>
            {(n) => {
              const on = () => needs().includes(n.id);
              return (
                <button
                  type="button"
                  aria-pressed={aria(on())}
                  onClick={() => setNeeds(on() ? needs().filter((x) => x !== n.id) : [...needs(), n.id])}
                  class={["cursor-pointer px-2 py-0.5 text-[12px]", on() ? "bg-leaf-500 text-bark-900" : "bg-cream-50 text-bark-800 hover:bg-cream-200"]}
                >
                  {n.title}
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={problem()}>
        <p class="text-[12px] text-berry">{problem()}</p>
      </Show>
      <div class="flex justify-end gap-1">
        <SmallBtn label={t("web.farm.never")} onClick={() => props.onDone()} />
        <SmallBtn label={props.node ? t("web.farm.graph.done") : t("web.farm.graph.add")} primary onClick={isReady() ? () => void save() : undefined} />
      </div>
    </div>
  );
}

const actorTone: Record<GraphEvent["actor"], [fill: string, ink: string]> = {
  owner: ["#74a046", "#f7e8c4"],
  orchestrator: ["#efd08f", "#2f1f13"],
  session: ["#bfd7ea", "#2f1f13"],
  system: ["#e2c995", "#2f1f13"],
};

const when = (at: number) => {
  const d = new Date(Math.round(at));
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function TaskLog(props: { graph: TaskGraph; only?: string | undefined; onAll: () => void }) {
  // Read when shown, and again whenever the graph changes: something happened.
  const events = useQuery(() => ({
    queryKey: ["graph-events", props.graph.id, JSON.stringify(props.graph)],
    queryFn: () => api.graph.event.list({ id: props.graph.id }),
  }));
  const titleOf = (id: string) => taskOf(props.graph, id)?.title ?? id;
  const shown = () =>
    ready(events, [] as GraphEvent[])
      .filter((e) => !props.only || e.task === props.only)
      .reverse();
  return (
    <FarmSection title={props.only ? t("web.farm.graph.storyOf", { title: titleOf(props.only) }) : t("web.farm.graph.story")}>
      <Show when={props.only}>
        <button
          type="button"
          onClick={() => props.onAll()}
          class="mb-2 cursor-pointer self-start bg-cream-200 px-2.5 py-0.5 text-[12px] text-bark-800 hover:bg-cream-300"
        >
          {t("web.farm.graph.wholeStory")}
        </button>
      </Show>
      <Show
        when={shown().length > 0}
        fallback={<p class="text-[13px] text-bark-600">{events.isSuccess ? t("web.farm.graph.nothing") : t("web.farm.graph.readingStory")}</p>}
      >
        <div class="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
          <For each={shown()} keyed={(e) => e.id}>
            {(e) => <LogRow e={e()} />}
          </For>
        </div>
      </Show>
    </FarmSection>
  );
}

function LogRow(props: { e: GraphEvent }) {
  const [open, setOpen] = createSignal(false);
  const changes = () => props.e.changes;
  return (
    <div class="flex items-start gap-2">
      <span class="w-[88px] shrink-0 text-[12px] text-bark-400">{when(props.e.at)}</span>
      <span class="w-11 shrink-0 py-0.5 text-center text-[10px]" style={{ background: actorTone[props.e.actor][0], color: actorTone[props.e.actor][1] }}>
        {props.e.actorText}
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-[12px] text-bark-800">{props.e.text}</p>
        <Show when={changes().length > 0}>
          <button type="button" onClick={() => setOpen(!open())} class="mt-0.5 cursor-pointer text-[12px] text-bark-600">
            {t("web.farm.graph.beforeAfter")}
          </button>
          <Show when={open()}>
            <For each={changes()}>
              {(c) => (
                <div class="mt-1 text-[12px] text-bark-600">
                  <p>{c.field}</p>
                  <p>
                    <span class="text-berry line-through">{c.from || t("web.farm.graph.empty")}</span> →{" "}
                    <span class="text-leaf-700">{c.to || t("web.farm.graph.empty")}</span>
                  </p>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}
