import { useQuery } from "@tanstack/react-query";
import type { GraphAction, Spent, Task, TaskAction, TaskGraph, TaskState } from "@vibevalley/protocol";
import { useState } from "react";
import { api, queries, reasonOf } from "../../data/api";
import type { Tone } from "../../rules/cards";
import { taskLine } from "../../rules/issues";
import { wallClockText } from "../../rules/time";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { ChangesBody, ChangesHead } from "./CloseDialog";
import { useNameOf } from "./hooks";
import { Fold, More, Note, Property, IssueSheet } from "./Sheet";

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
    void queries.invalidateQueries({ queryKey: ["issues"] });
  }
}

const spentText = (s: Spent) =>
  [s.cny !== undefined ? `¥${s.cny.toFixed(2)}` : undefined, s.tokens > 0 ? `${Math.round(s.tokens)} token` : undefined].filter(Boolean).join(" · ") || "—";

const stepTone: Record<TaskState, Tone> = { waiting: "faint", working: "water", merged: "leaf", failed: "berry", skipped: "muted" };

/** A task (计划 on screen): an issue whose work is split into steps, each its own issue, run in the order their needs
 * allow. `stepIssues` is a step's own issue by the step's id, once a helper has worked it. */
export function TaskDetail({ graph, stepIssues, onOpen }: { graph: TaskGraph; stepIssues: Record<string, string>; onOpen: (id: string) => void }) {
  const [said, setSaid] = useState<Said | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const nameOf = useNameOf();
  const total = graph.tasks.length;
  const settled = Math.round(graph.settled ?? 0);
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  // The order they can run in; before the server has laid them out, the order they were written in.
  const layers = graph.layers?.length ? graph.layers : graph.tasks.map((t) => [t.id]);
  const actions = graph.actions ?? [];
  const word = (a: GraphAction) => graph.actionText?.[a] ?? "";
  const act = async (a: GraphAction) => setSaid(await answer(() => api.graph.act({ id: graph.id, body: { action: a } })));
  const actOnStep = async (t: Task, a: TaskAction) => setSaid(await answer(() => api.graph.taskAct({ id: graph.id, task: t.id, body: { action: a } })));

  const heading = (
    <div className="pr-10">
      <div className="flex items-center gap-2 px-2">
        <span className="inline-flex items-center gap-1 rounded bg-leaf/30 px-1.5 py-0.5 text-xs">
          <Icon name="icon-tasks" size={12} />
          计划
        </span>
        <span className="text-xs text-muted">{total} 步</span>
      </div>
      <h1 className="mt-2 px-2 text-xl font-semibold">{graph.title}</h1>
      {graph.goal && graph.goal !== graph.title && <Markdown className="mt-2 px-2 text-sm" text={graph.goal} />}
    </div>
  );

  const main = (
    <>
      <div>
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold">
            做完 {settled} / {total} 步
          </span>
          {/* Running, the bar already says how far; otherwise the state's own words. */}
          <span className="truncate text-xs text-muted">{graph.state === "running" ? "" : taskLine(graph)}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
          <div className="h-full bg-leaf" style={{ width: `${total === 0 ? 0 : Math.min(100, (settled / total) * 100)}%` }} />
        </div>
      </div>
      {graph.asksForYou && (
        <Note tone="wheat" className="mt-2.5">
          有一步在等你：打开它回答或者验收。
        </Note>
      )}
      {graph.state === "splitting" && (
        <Note tone="water" className="mt-2.5">
          管家在把它拆成步骤，拆好了会列在下面。
        </Note>
      )}
      {said && (
        <Note tone={said.ok ? "leaf" : "berry"} className="mt-2.5">
          {said.text || "好了。"}
        </Note>
      )}
      {reviewing && (
        <TaskHarvest
          graph={graph}
          onDone={(a) => {
            setReviewing(false);
            if (a) setSaid(a);
          }}
        />
      )}
      <div className="mt-4">
        {layers.map((layer, i) => (
          <div key={i}>
            {layers.length > 1 && (
              <div className="mt-3 mb-1 text-xs font-semibold text-muted">
                {layer.length > 1 ? `第 ${i + 1} 批 · 这 ${layer.length} 步可以同时做` : `第 ${i + 1} 批`}
              </div>
            )}
            {layer.map((id) => {
              const task = byId.get(id);
              if (!task) return null;
              const waitsOn = (task.blockedBy ?? []).map((b) => byId.get(b)?.title ?? b);
              const summary = [
                task.stateText ?? task.state,
                ...(task.agent ? [nameOf(task.agent)] : []),
                ...(task.state === "waiting" && waitsOn.length ? [`等「${waitsOn.join("」「")}」`] : []),
              ].join(" · ");
              const issue = stepIssues[task.id];
              return (
                <Fold
                  key={id}
                  label={task.title}
                  summary={summary}
                  leading={
                    task.state === "merged" ? (
                      <Icon name="mark-check" size={12} />
                    ) : (
                      <span className="size-2 shrink-0 rounded-full" style={{ background: `var(--color-${stepTone[task.state]})` }} />
                    )
                  }
                >
                  {task.brief && <Markdown className="text-sm" text={task.brief} />}
                  {task.check && (
                    <Property label="检查">
                      <span className="font-mono text-xs">{task.check}</span>
                    </Property>
                  )}
                  {task.scope?.length ? (
                    <Property label="改哪里">
                      <span className="font-mono text-xs">{task.scope.join("、")}</span>
                    </Property>
                  ) : null}
                  {task.conclusion && <Property label="结论">{task.conclusion}</Property>}
                  {task.spent && <Property label="花了">{spentText(task.spent)}</Property>}
                  {task.tries > 1 && <Property label="试了">{task.tries} 次</Property>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {issue && (
                      <Button icon="button-open" onClick={() => onOpen(issue)}>
                        打开这张工单
                      </Button>
                    )}
                    {(task.actions ?? []).map((a) => (
                      <Button key={a} onClick={() => actOnStep(task, a)}>
                        {task.actionText?.[a] ?? a}
                      </Button>
                    ))}
                  </div>
                </Fold>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );

  const side = (
    <>
      <div className="mb-3 flex flex-col gap-2 empty:hidden">
        {actions.includes("start") && (
          <Button tone="primary" onClick={() => act("start")}>
            {word("start")}
          </Button>
        )}
        {graph.state === "paused" && (
          <Button tone="primary" onClick={() => act("resume")}>
            {word("resume")}
          </Button>
        )}
        {graph.state === "ripe" && (
          <Button tone="primary" onClick={() => setReviewing(true)}>
            看改动，{word("merge")}…
          </Button>
        )}
        {actions.includes("pause") && <Button onClick={() => act("pause")}>{word("pause")}</Button>}
        {actions.includes("abandon") && (
          <Button tone="quiet" onClick={() => setAbandoning(true)}>
            {word("abandon")}…
          </Button>
        )}
      </div>
      <Property label="状态">{graph.stateTag ?? graph.state}</Property>
      <Property label="项目">{graph.project}</Property>
      <Property label="进度">
        {settled} / {total} 步
      </Property>
      {graph.spent && <Property label="花了">{spentText(graph.spent)}</Property>}
      <More>
        {graph.branch && (
          <Property label="分支">
            <span className="font-mono text-xs">{graph.branch}</span>
          </Property>
        )}
        <Property label="同时做">至多 {graph.parallel} 步</Property>
        <Property label="写于">{wallClockText(graph.createdAt)}</Property>
        {graph.note && <Property label="备注">{graph.note}</Property>}
      </More>
      {abandoning && (
        <Dialog open onClose={() => setAbandoning(false)} title={`${word("abandon")}这个计划？`}>
          <p>还没做完的步骤不再派出去；计划分支留着，做好的提交都还在。</p>
          <div className="mt-4 flex justify-end gap-2">
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
      )}
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

/** A ripe task's changes before they go into the main branch: its commits and files, and the merge. */
function TaskHarvest({ graph, onDone }: { graph: TaskGraph; onDone: (said: Said | null) => void }) {
  const changes = useQuery({ queryKey: ["issues", "graph-changes", graph.id], queryFn: () => api.graph.changes({ id: graph.id }) });
  const c = changes.data;
  return (
    <div className="mt-4 rounded-lg border border-line p-3">
      {changes.error ? (
        <>
          <p className="text-sm text-berry">看不了改动：{reasonOf(changes.error)}</p>
          <Button className="mt-2" onClick={() => onDone(null)}>
            先不收
          </Button>
        </>
      ) : !c ? (
        <p className="text-sm text-muted">正在看计划分支改了什么…</p>
      ) : (
        <div className="flex flex-col gap-2">
          <ChangesHead changes={c} />
          {c.behind > 0 && (
            <p className="text-xs text-muted">
              这期间 {c.base} 多了 {c.behind} 个提交
            </p>
          )}
          {c.conflicts.length > 0 && (
            <Note tone="berry">
              合进 {c.base} 会冲突：{c.conflicts.join("、")}。先不收，等 {c.base} 上的改动处理好。
            </Note>
          )}
          <ChangesBody changes={c} />
          <div className="mt-2 flex justify-end gap-2">
            <Button onClick={() => onDone(null)}>先不收</Button>
            <Button
              tone="primary"
              disabled={c.conflicts.length > 0}
              onClick={async () => onDone(await answer(() => api.graph.act({ id: graph.id, body: { action: "merge" } })))}
            >
              确认收获，合进 {c.base}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
