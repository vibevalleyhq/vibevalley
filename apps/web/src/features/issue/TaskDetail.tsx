import { list, t } from "@vibevalley/i18n";
import { createSignal, For, Show } from "solid-js";

import type { GraphAction, Spent, Task, TaskAction, TaskGraph, TaskState } from "@vibevalley/protocol";
import { reasonOf } from "@/base/api";
import type { Tone } from "./cards";
import { taskLine } from "./titles";
import { wallClockText } from "@/base/format";
import { ready } from "@/base/query";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Icon } from "@/ui/Icon";
import { Markdown } from "@/ui/Markdown";
import { ChangesBody, ChangesHead } from "./CloseDialog";
import { useNameOf } from "./queries";
import { Fold, IssueSheet, More, Note, Property } from "./Sheet";
import { type Answer, graphs, useGraphChanges } from "@/features/task";

const spentText = (s: Spent) =>
  [s.cny !== undefined ? `¥${s.cny.toFixed(2)}` : undefined, s.tokens > 0 ? `${Math.round(s.tokens)} token` : undefined].filter(Boolean).join(" · ") || "—";

const stepTone: Record<TaskState, Tone> = { waiting: "faint", working: "water", merged: "leaf", failed: "berry", skipped: "muted" };

/** A task (计划 on screen): an issue whose work is split into steps, each its own issue, run in the order their needs
 * allow. `stepIssues` is a step's own issue by the step's id, once a helper has worked it. */
export function TaskDetail(props: { graph: TaskGraph; stepIssues: Record<string, string>; onOpen: (id: string) => void }) {
  const [said, setSaid] = createSignal<Answer>();
  const [reviewing, setReviewing] = createSignal(false);
  const [abandoning, setAbandoning] = createSignal(false);
  const nameOf = useNameOf();
  const g = () => props.graph;
  const total = () => g().tasks.length;
  const settled = () => Math.round(g().settled ?? 0);
  const byId = () => new Map(g().tasks.map((t) => [t.id, t]));
  // The order they can run in; before the server has laid them out, the order they were written in.
  const layers = () => (g().layers.length ? g().layers : g().tasks.map((t) => [t.id]));
  const actions = () => g().actions;
  const word = (a: GraphAction) => g().actionText[a] ?? "";
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
          <Icon name="issues" size={12} />
          {t("web.issue.task.label")}
        </span>
        <span class="text-xs text-muted">{t("web.issue.task.steps", { n: total() })}</span>
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
          <span class="text-sm font-semibold">{t("web.issue.task.done", { done: settled(), of: total() })}</span>
          {/* Running, the bar already says how far; otherwise the state's own words. */}
          <span class="truncate text-xs text-muted">{g().state === "running" ? "" : taskLine(g())}</span>
        </div>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
          <div class="h-full bg-leaf" style={{ width: `${total() === 0 ? 0 : Math.min(100, (settled() / total()) * 100)}%` }} />
        </div>
      </div>
      <Show when={g().asksForYou}>
        <Note tone="wheat" class="mt-2.5">
          {t("web.issue.task.waitsForYou")}
        </Note>
      </Show>
      <Show when={g().state === "splitting"}>
        <Note tone="water" class="mt-2.5">
          {t("web.issue.task.splitting")}
        </Note>
      </Show>
      <Show when={said()}>
        {(s) => (
          <Note tone={s().ok ? "leaf" : "berry"} class="mt-2.5">
            {s().text || t("web.issue.task.ok")}
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
                <div class="mt-3 mb-1 text-xs font-semibold text-muted">
                  {layer().length > 1 ? t("web.issue.task.layerTogether", { n: i() + 1, size: layer().length }) : t("web.issue.task.layer", { n: i() + 1 })}
                </div>
              </Show>
              <For each={layer()}>
                {(id) => (
                  <Show when={byId().get(id)}>
                    {(task) => {
                      const summary = () => {
                        const step = task();
                        const waitsOn = step.blockedBy.map((b) => byId().get(b)?.title ?? b);
                        return [
                          step.stateText || step.state,
                          ...(step.agent ? [nameOf()(step.agent)] : []),
                          ...(step.state === "waiting" && waitsOn.length
                            ? [t("web.issue.task.waitsOn", { steps: waitsOn.join(t("web.issue.task.stepSeparator")) })]
                            : []),
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
                              <Icon name="check" size={12} />
                            </Show>
                          }
                        >
                          <Show when={task().brief}>
                            <Markdown class="text-sm" text={task().brief} />
                          </Show>
                          <Show when={task().check}>
                            <Property label={t("web.issue.task.check")}>
                              <span class="font-mono text-xs">{task().check}</span>
                            </Property>
                          </Show>
                          <Show when={task().scope.length}>
                            <Property label={t("web.issue.task.scope")}>
                              <span class="font-mono text-xs">{list(task().scope)}</span>
                            </Property>
                          </Show>
                          <Show when={task().conclusion}>
                            <Property label={t("web.issue.task.conclusion")}>{task().conclusion}</Property>
                          </Show>
                          <Show when={task().spent}>{(sp) => <Property label={t("web.issue.task.spent")}>{spentText(sp())}</Property>}</Show>
                          <Show when={task().tries > 1}>
                            <Property label={t("web.issue.task.tried")}>{t("web.issue.task.tries", { n: task().tries })}</Property>
                          </Show>
                          <div class="mt-2 flex flex-wrap gap-2">
                            <Show when={issue()}>
                              {(is) => (
                                <Button icon="open" onClick={() => props.onOpen(is())}>
                                  {t("web.issue.task.open")}
                                </Button>
                              )}
                            </Show>
                            <For each={task().actions}>{(a) => <Button onClick={() => void actOnStep(task(), a)}>{task().actionText[a] ?? a}</Button>}</For>
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
            {t("web.issue.task.review", { merge: word("merge") })}
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
      <Property label={t("web.issue.task.state")}>{g().stateTag || g().state}</Property>
      <Property label={t("web.issue.task.project")}>{g().project}</Property>
      <Property label={t("web.issue.task.progress")}>{t("web.issue.task.progressLine", { done: settled(), of: total() })}</Property>
      <Show when={g().spent}>{(sp) => <Property label={t("web.issue.task.spent")}>{spentText(sp())}</Property>}</Show>
      <More>
        <Show when={g().branch}>
          <Property label={t("web.issue.detail.branch")}>
            <span class="font-mono text-xs">{g().branch}</span>
          </Property>
        </Show>
        <Property label={t("web.issue.task.parallel")}>{t("web.issue.task.atMost", { n: g().parallel })}</Property>
        <Property label={t("web.issue.task.written")}>{wallClockText(g().createdAt)}</Property>
        <Show when={g().note}>
          <Property label={t("web.issue.task.note")}>{g().note}</Property>
        </Show>
      </More>
      <Show when={abandoning()}>
        <Dialog open onClose={() => setAbandoning(false)} title={t("web.issue.task.abandonTitle", { abandon: word("abandon") })}>
          <p>{t("web.issue.task.abandonLine")}</p>
          <div class="mt-4 flex justify-end gap-2">
            <Button onClick={() => setAbandoning(false)}>{t("web.issue.never")}</Button>
            <Button
              tone="danger"
              onClick={() => {
                setAbandoning(false);
                void act("abandon");
              }}
            >
              {t("web.issue.task.abandon")}
            </Button>
          </div>
        </Dialog>
      </Show>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

/** A finished graph's changes before they go into the main branch: its commits and files, and the merge. */
function GraphMerge(props: { graph: TaskGraph; onDone: (said: Answer | undefined) => void }) {
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
              {t("web.issue.changes.unreadable")}
              {reasonOf(changes.error)}
            </p>
            <Button class="mt-2" onClick={() => props.onDone(undefined)}>
              {t("web.issue.later")}
            </Button>
          </>
        }
      >
        <Show when={ready(changes, undefined)} fallback={<p class="text-sm text-muted">{t("web.issue.task.reading")}</p>}>
          {(c) => (
            <div class="flex flex-col gap-2">
              <ChangesHead changes={c()} />
              <Show when={c().behind > 0}>
                <p class="text-xs text-muted">{t("web.issue.task.behind", { base: c().base, n: c().behind })}</p>
              </Show>
              <Show when={c().conflicts.length > 0}>
                <Note tone="berry">{t("web.issue.task.conflict", { base: c().base, files: list(c().conflicts) })}</Note>
              </Show>
              <ChangesBody changes={c()} />
              <div class="mt-2 flex justify-end gap-2">
                <Button onClick={() => props.onDone(undefined)}>{t("web.issue.later")}</Button>
                <Button tone="primary" disabled={c().conflicts.length > 0} onClick={() => void merge()}>
                  {t("web.issue.task.merge", { base: c().base })}
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
