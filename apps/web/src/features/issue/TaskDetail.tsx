import { issuesWording } from "./words";
import { createSignal, For, Show } from "solid-js";

import type { GraphAction, Spent, Task, TaskAction, TaskGraph, TaskState } from "@vibevalley/protocol";
import { reasonOf } from "../../base/api";
import type { Tone } from "./cards";
import { taskLine } from "./rules";
import { wallClockText } from "../../base/format";
import { ready } from "../../base/query";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { ChangesBody, ChangesHead } from "./CloseDialog";
import { useNameOf } from "./hooks";
import { Fold, IssueSheet, More, Note, Property } from "./Sheet";
import { type Answer, graphs, useGraphChanges } from "../task";

const spentText = (s: Spent) =>
  [s.cny !== undefined ? `¥${s.cny.toFixed(2)}` : undefined, s.tokens > 0 ? `${Math.round(s.tokens)} token` : undefined].filter(Boolean).join(" · ") || "—";

const stepTone: Record<TaskState, Tone> = { waiting: "faint", working: "water", merged: "leaf", failed: "berry", skipped: "muted" };

/** A task (计划 on screen): an issue whose work is split into steps, each its own issue, run in the order their needs
 * allow. `stepIssues` is a step's own issue by the step's id, once a helper has worked it. */
export function TaskDetail(props: { graph: TaskGraph; stepIssues: Record<string, string>; onOpen: (id: string) => void }) {
  const [said, setSaid] = createSignal<Answer | null>(null);
  const [reviewing, setReviewing] = createSignal(false);
  const [abandoning, setAbandoning] = createSignal(false);
  const nameOf = useNameOf();
  const g = () => props.graph;
  const total = () => g().tasks.length;
  const settled = () => Math.round(g().settled ?? 0);
  const byId = () => new Map(g().tasks.map((t) => [t.id, t]));
  // The order they can run in; before the server has laid them out, the order they were written in.
  const layers = () => (g().layers?.length ? g().layers! : g().tasks.map((t) => [t.id]));
  const actions = () => g().actions ?? [];
  const word = (a: GraphAction) => g().actionText?.[a] ?? "";
  const act = async (a: GraphAction) => {
    const id = g().id;
    setSaid(await graphs.act(id, a));
  };
  const actOnStep = async (t: Task, a: TaskAction) => {
    const id = g().id;
    setSaid(await graphs.taskAct(id, t.id, a));
  };

  const heading = (
    <div class="pr-10">
      <div class="flex items-center gap-2 px-2">
        <span class="inline-flex items-center gap-1 rounded bg-leaf/30 px-1.5 py-0.5 text-xs">
          <Icon name="icon-tasks" size={12} />
          {issuesWording().task.label}
        </span>
        <span class="text-xs text-muted">{issuesWording().task.steps(total())}</span>
      </div>
      <h1 class="mt-2 px-2 text-xl font-semibold">{g().title}</h1>
      <Show when={g().goal && g().goal !== g().title}>
        <Markdown class="mt-2 px-2 text-sm" text={g().goal} />
      </Show>
    </div>
  );

  const main = (
    <>
      <div>
        <div class="flex items-center gap-2.5">
          <span class="text-sm font-semibold">{issuesWording().task.done(settled(), total())}</span>
          {/* Running, the bar already says how far; otherwise the state's own words. */}
          <span class="truncate text-xs text-muted">{g().state === "running" ? "" : taskLine(g())}</span>
        </div>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
          <div class="h-full bg-leaf" style={{ width: `${total() === 0 ? 0 : Math.min(100, (settled() / total()) * 100)}%` }} />
        </div>
      </div>
      <Show when={g().asksForYou}>
        <Note tone="wheat" class="mt-2.5">
          {issuesWording().task.waitsForYou}
        </Note>
      </Show>
      <Show when={g().state === "splitting"}>
        <Note tone="water" class="mt-2.5">
          {issuesWording().task.splitting}
        </Note>
      </Show>
      <Show when={said()}>
        {(s) => (
          <Note tone={s().ok ? "leaf" : "berry"} class="mt-2.5">
            {s().text || issuesWording().task.ok}
          </Note>
        )}
      </Show>
      <Show when={reviewing()}>
        <GraphMerge
          graph={g()}
          onDone={(a) => {
            setReviewing(false);
            if (a) setSaid(a);
          }}
        />
      </Show>
      <div class="mt-4">
        {/* A layer made for each task is a new array every time: by its tasks, so a batch's rows stay. */}
        <For each={layers()} keyed={(layer) => layer.join(" ")}>
          {(layer, i) => (
            <div>
              <Show when={layers().length > 1}>
                <div class="mt-3 mb-1 text-xs font-semibold text-muted">{issuesWording().task.layer(i() + 1, layer().length)}</div>
              </Show>
              <For each={layer()}>
                {(id) => (
                  <Show when={byId().get(id)}>
                    {(task) => {
                      const summary = () => {
                        const t = task();
                        const waitsOn = (t.blockedBy ?? []).map((b) => byId().get(b)?.title ?? b);
                        return [
                          t.stateText ?? t.state,
                          ...(t.agent ? [nameOf()(t.agent)] : []),
                          ...(t.state === "waiting" && waitsOn.length ? [issuesWording().task.waitsOn(waitsOn)] : []),
                        ].join(" · ");
                      };
                      const issue = () => props.stepIssues[task().id];
                      return (
                        <Fold
                          label={task().title}
                          summary={summary()}
                          leading={
                            <Show
                              when={task().state === "merged"}
                              fallback={<span class="size-2 shrink-0 rounded-full" style={{ background: `var(--color-${stepTone[task().state]})` }} />}
                            >
                              <Icon name="mark-check" size={12} />
                            </Show>
                          }
                        >
                          <Show when={task().brief}>
                            <Markdown class="text-sm" text={task().brief} />
                          </Show>
                          <Show when={task().check}>
                            <Property label={issuesWording().task.check}>
                              <span class="font-mono text-xs">{task().check}</span>
                            </Property>
                          </Show>
                          <Show when={task().scope?.length}>
                            <Property label={issuesWording().task.scope}>
                              <span class="font-mono text-xs">{task().scope!.join("、")}</span>
                            </Property>
                          </Show>
                          <Show when={task().conclusion}>
                            <Property label={issuesWording().task.conclusion}>{task().conclusion}</Property>
                          </Show>
                          <Show when={task().spent}>{(sp) => <Property label={issuesWording().task.spent}>{spentText(sp())}</Property>}</Show>
                          <Show when={task().tries > 1}>
                            <Property label={issuesWording().task.tried}>{issuesWording().task.tries(task().tries)}</Property>
                          </Show>
                          <div class="mt-2 flex flex-wrap gap-2">
                            <Show when={issue()}>
                              {(is) => (
                                <Button icon="button-open" onClick={() => props.onOpen(is())}>
                                  {issuesWording().task.open}
                                </Button>
                              )}
                            </Show>
                            <For each={task().actions ?? []}>
                              {(a) => <Button onClick={() => void actOnStep(task(), a)}>{task().actionText?.[a] ?? a}</Button>}
                            </For>
                          </div>
                        </Fold>
                      );
                    }}
                  </Show>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </>
  );

  const side = (
    <>
      <div class="mb-3 flex flex-col gap-2 empty:hidden">
        <Show when={actions().includes("start")}>
          <Button tone="primary" onClick={() => void act("start")}>
            {word("start")}
          </Button>
        </Show>
        <Show when={g().state === "paused"}>
          <Button tone="primary" onClick={() => void act("resume")}>
            {word("resume")}
          </Button>
        </Show>
        <Show when={g().state === "ready"}>
          <Button tone="primary" onClick={() => setReviewing(true)}>
            {issuesWording().task.review(word("merge"))}
          </Button>
        </Show>
        <Show when={actions().includes("pause")}>
          <Button onClick={() => void act("pause")}>{word("pause")}</Button>
        </Show>
        <Show when={actions().includes("abandon")}>
          <Button tone="quiet" onClick={() => setAbandoning(true)}>
            {word("abandon")}…
          </Button>
        </Show>
      </div>
      <Property label={issuesWording().task.state}>{g().stateTag ?? g().state}</Property>
      <Property label={issuesWording().task.project}>{g().project}</Property>
      <Property label={issuesWording().task.progress}>{issuesWording().task.progressLine(settled(), total())}</Property>
      <Show when={g().spent}>{(sp) => <Property label={issuesWording().task.spent}>{spentText(sp())}</Property>}</Show>
      <More>
        <Show when={g().branch}>
          <Property label={issuesWording().detail.branch}>
            <span class="font-mono text-xs">{g().branch}</span>
          </Property>
        </Show>
        <Property label={issuesWording().task.parallel}>{issuesWording().task.atMost(g().parallel)}</Property>
        <Property label={issuesWording().task.written}>{wallClockText(g().createdAt)}</Property>
        <Show when={g().note}>
          <Property label={issuesWording().task.note}>{g().note}</Property>
        </Show>
      </More>
      <Show when={abandoning()}>
        <Dialog open onClose={() => setAbandoning(false)} title={issuesWording().task.abandonTitle(word("abandon"))}>
          <p>{issuesWording().task.abandonLine}</p>
          <div class="mt-4 flex justify-end gap-2">
            <Button onClick={() => setAbandoning(false)}>{issuesWording().never}</Button>
            <Button
              tone="danger"
              onClick={() => {
                setAbandoning(false);
                void act("abandon");
              }}
            >
              {issuesWording().task.abandon}
            </Button>
          </div>
        </Dialog>
      </Show>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

/** A finished graph's changes before they go into the main branch: its commits and files, and the merge. */
function GraphMerge(props: { graph: TaskGraph; onDone: (said: Answer | null) => void }) {
  const changes = useGraphChanges(() => props.graph.id);
  const merge = async () => {
    const id = props.graph.id;
    props.onDone(await graphs.act(id, "merge"));
  };
  return (
    <div class="mt-4 rounded-lg border border-line p-3">
      <Show
        when={!changes.error}
        fallback={
          <>
            <p class="text-sm text-berry">
              {issuesWording().changes.unreadable}
              {reasonOf(changes.error)}
            </p>
            <Button class="mt-2" onClick={() => props.onDone(null)}>
              {issuesWording().later}
            </Button>
          </>
        }
      >
        <Show when={ready(changes, undefined)} fallback={<p class="text-sm text-muted">{issuesWording().task.reading}</p>}>
          {(c) => (
            <div class="flex flex-col gap-2">
              <ChangesHead changes={c()} />
              <Show when={c().behind > 0}>
                <p class="text-xs text-muted">{issuesWording().task.behind(c().base, c().behind)}</p>
              </Show>
              <Show when={c().conflicts.length > 0}>
                <Note tone="berry">{issuesWording().task.conflict(c().base, c().conflicts)}</Note>
              </Show>
              <ChangesBody changes={c()} />
              <div class="mt-2 flex justify-end gap-2">
                <Button onClick={() => props.onDone(null)}>{issuesWording().later}</Button>
                <Button tone="primary" disabled={c().conflicts.length > 0} onClick={() => void merge()}>
                  {issuesWording().task.merge(c().base)}
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
