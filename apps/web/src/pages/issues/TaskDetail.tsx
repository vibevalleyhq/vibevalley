import { createSignal, For, Show } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import type { GraphAction, Spent, Task, TaskAction, TaskGraph, TaskState } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import type { Tone } from "../../rules/cards";
import { taskLine } from "../../rules/issues";
import { wallClockText } from "../../rules/time";
import { ready } from "../../data/query";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { ChangesBody, ChangesHead } from "./CloseDialog";
import { reloadIssues, useNameOf } from "./hooks";
import { Fold, IssueSheet, More, Note, Property } from "./Sheet";

/** What the server said to an action: ok, or why not. */
interface Said {
  ok: boolean;
  text: string;
}

async function answer(call: () => Promise<string>): Promise<Said> {
  try {
    return { ok: true, text: await call() };
  } catch (e) {
    return { ok: false, text: reasonOf(e) };
  } finally {
    void reloadIssues();
  }
}

const spentText = (s: Spent) =>
  [s.cny !== undefined ? `¥${s.cny.toFixed(2)}` : undefined, s.tokens > 0 ? `${Math.round(s.tokens)} token` : undefined].filter(Boolean).join(" · ") || "—";

const stepTone: Record<TaskState, Tone> = { waiting: "faint", working: "water", merged: "leaf", failed: "berry", skipped: "muted" };

/** A task (计划 on screen): an issue whose work is split into steps, each its own issue, run in the order their needs
 * allow. `stepIssues` is a step's own issue by the step's id, once a helper has worked it. */
export function TaskDetail(props: { graph: TaskGraph; stepIssues: Record<string, string>; onOpen: (id: string) => void }) {
  const [said, setSaid] = createSignal<Said | null>(null);
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
    setSaid(await answer(() => api.graph.act({ id, body: { action: a } })));
  };
  const actOnStep = async (t: Task, a: TaskAction) => {
    const id = g().id;
    setSaid(await answer(() => api.graph.taskAct({ id, task: t.id, body: { action: a } })));
  };

  const heading = (
    <div class="pr-10">
      <div class="flex items-center gap-2 px-2">
        <span class="inline-flex items-center gap-1 rounded bg-leaf/30 px-1.5 py-0.5 text-xs">
          <Icon name="icon-tasks" size={12} />
          计划
        </span>
        <span class="text-xs text-muted">{total()} 步</span>
      </div>
      <h1 class="mt-2 px-2 text-xl font-semibold">{g().title}</h1>
      <Show when={g().goal && g().goal !== g().title}>
        <Markdown class="mt-2 px-2 text-sm" text={g().goal!} />
      </Show>
    </div>
  );

  const main = (
    <>
      <div>
        <div class="flex items-center gap-2.5">
          <span class="text-sm font-semibold">
            做完 {settled()} / {total()} 步
          </span>
          {/* Running, the bar already says how far; otherwise the state's own words. */}
          <span class="truncate text-xs text-muted">{g().state === "running" ? "" : taskLine(g())}</span>
        </div>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
          <div class="h-full bg-leaf" style={{ width: `${total() === 0 ? 0 : Math.min(100, (settled() / total()) * 100)}%` }} />
        </div>
      </div>
      <Show when={g().asksForYou}>
        <Note tone="wheat" class="mt-2.5">
          有一步在等你：打开它回答或者验收。
        </Note>
      </Show>
      <Show when={g().state === "splitting"}>
        <Note tone="water" class="mt-2.5">
          管家在把它拆成步骤，拆好了会列在下面。
        </Note>
      </Show>
      <Show when={said()}>
        {(s) => (
          <Note tone={s().ok ? "leaf" : "berry"} class="mt-2.5">
            {s().text || "好了。"}
          </Note>
        )}
      </Show>
      <Show when={reviewing()}>
        <TaskHarvest
          graph={g()}
          onDone={(a) => {
            setReviewing(false);
            if (a) setSaid(a);
          }}
        />
      </Show>
      <div class="mt-4">
        <For each={layers()}>
          {(layer, i) => (
            <div>
              <Show when={layers().length > 1}>
                <div class="mt-3 mb-1 text-xs font-semibold text-muted">
                  {layer.length > 1 ? `第 ${i() + 1} 批 · 这 ${layer.length} 步可以同时做` : `第 ${i() + 1} 批`}
                </div>
              </Show>
              <For each={layer}>
                {(id) => (
                  <Show when={byId().get(id)}>
                    {(task) => {
                      const summary = () => {
                        const t = task();
                        const waitsOn = (t.blockedBy ?? []).map((b) => byId().get(b)?.title ?? b);
                        return [
                          t.stateText ?? t.state,
                          ...(t.agent ? [nameOf()(t.agent)] : []),
                          ...(t.state === "waiting" && waitsOn.length ? [`等「${waitsOn.join("」「")}」`] : []),
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
                            <Markdown class="text-sm" text={task().brief!} />
                          </Show>
                          <Show when={task().check}>
                            <Property label="检查">
                              <span class="font-mono text-xs">{task().check}</span>
                            </Property>
                          </Show>
                          <Show when={task().scope?.length}>
                            <Property label="改哪里">
                              <span class="font-mono text-xs">{task().scope!.join("、")}</span>
                            </Property>
                          </Show>
                          <Show when={task().conclusion}>
                            <Property label="结论">{task().conclusion}</Property>
                          </Show>
                          <Show when={task().spent}>{(sp) => <Property label="花了">{spentText(sp())}</Property>}</Show>
                          <Show when={task().tries > 1}>
                            <Property label="试了">{task().tries} 次</Property>
                          </Show>
                          <div class="mt-2 flex flex-wrap gap-2">
                            <Show when={issue()}>
                              {(is) => (
                                <Button icon="button-open" onClick={() => props.onOpen(is())}>
                                  打开这张工单
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
        <Show when={g().state === "ripe"}>
          <Button tone="primary" onClick={() => setReviewing(true)}>
            看改动，{word("merge")}…
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
      <Property label="状态">{g().stateTag ?? g().state}</Property>
      <Property label="项目">{g().project}</Property>
      <Property label="进度">
        {settled()} / {total()} 步
      </Property>
      <Show when={g().spent}>{(sp) => <Property label="花了">{spentText(sp())}</Property>}</Show>
      <More>
        <Show when={g().branch}>
          <Property label="分支">
            <span class="font-mono text-xs">{g().branch}</span>
          </Property>
        </Show>
        <Property label="同时做">至多 {g().parallel} 步</Property>
        <Property label="写于">{wallClockText(g().createdAt)}</Property>
        <Show when={g().note}>
          <Property label="备注">{g().note}</Property>
        </Show>
      </More>
      <Show when={abandoning()}>
        <Dialog open onClose={() => setAbandoning(false)} title={`${word("abandon")}这个计划？`}>
          <p>还没做完的步骤不再派出去；计划分支留着，做好的提交都还在。</p>
          <div class="mt-4 flex justify-end gap-2">
            <Button onClick={() => setAbandoning(false)}>算了</Button>
            <Button
              tone="danger"
              onClick={() => {
                setAbandoning(false);
                void act("abandon");
              }}
            >
              确定放弃
            </Button>
          </div>
        </Dialog>
      </Show>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

/** A ripe task's changes before they go into the main branch: its commits and files, and the merge. */
function TaskHarvest(props: { graph: TaskGraph; onDone: (said: Said | null) => void }) {
  const changes = useQuery(() => ({ queryKey: ["issues", "graph-changes", props.graph.id], queryFn: () => api.graph.changes({ id: props.graph.id }) }));
  const merge = async () => {
    const id = props.graph.id;
    props.onDone(await answer(() => api.graph.act({ id, body: { action: "merge" } })));
  };
  return (
    <div class="mt-4 rounded-lg border border-line p-3">
      <Show
        when={!changes.error}
        fallback={
          <>
            <p class="text-sm text-berry">看不了改动：{reasonOf(changes.error)}</p>
            <Button class="mt-2" onClick={() => props.onDone(null)}>
              先不收
            </Button>
          </>
        }
      >
        <Show when={ready(changes, undefined)} fallback={<p class="text-sm text-muted">正在看计划分支改了什么…</p>}>
          {(c) => (
            <div class="flex flex-col gap-2">
              <ChangesHead changes={c()} />
              <Show when={c().behind > 0}>
                <p class="text-xs text-muted">
                  这期间 {c().base} 多了 {c().behind} 个提交
                </p>
              </Show>
              <Show when={c().conflicts.length > 0}>
                <Note tone="berry">
                  合进 {c().base} 会冲突：{c().conflicts.join("、")}。先不收，等 {c().base} 上的改动处理好。
                </Note>
              </Show>
              <ChangesBody changes={c()} />
              <div class="mt-2 flex justify-end gap-2">
                <Button onClick={() => props.onDone(null)}>先不收</Button>
                <Button tone="primary" disabled={c().conflicts.length > 0} onClick={() => void merge()}>
                  确认收获，合进 {c().base}
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
