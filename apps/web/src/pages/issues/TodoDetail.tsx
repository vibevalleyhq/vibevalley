import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import { type Review, type Issue, type IssueUpdate, type Priority, PriorityValues } from "@vibevalley/protocol";
import { api } from "../../data/api";
import { rememberPick } from "./write";
import { isRefined, newIssueTitle, priorityLabel } from "../../rules/issues";
import { ago, wallClockText } from "../../rules/time";
import { toast } from "../../ui/toasts";
import { autofocus } from "../../app/util";
import { useWorkAgents } from "../../data/agents";
import { ready, queries, useProjects } from "../../data/query";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TextArea, TextInput } from "../../ui/Field";
import { run } from "./hooks";
import { Fold, IssueSheet, More, Note, Pick, Property, SheetLabel, Stages } from "./Sheet";

interface Draft {
  title: string;
  description: string;
  criteria: string;
  project: string;
  agent: string;
  priority: Priority;
  acceptance: Review;
}

const draftOf = (i: Issue): Draft => ({
  title: i.title,
  description: i.description ?? "",
  criteria: (i.criteria ?? []).join("\n"),
  project: i.project ?? "",
  agent: i.assignee ?? "",
  priority: i.priority,
  acceptance: i.review,
});

const criteriaList = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Moved to todo: it is either worked already, or waits there for room. */
export const dispatchedNotice = (open: (id: string | undefined) => void) => (got: Issue) => {
  if (got.status === "todo") toast("排上队了：地都满了，有空地就自动开工。");
  else open(got.id);
};

/** An issue not sent yet. In the backlog it is a draft: the box says what is wanted (or answers what its refiner asked)
 * and sends a helper to draft it; the fields are the draft, each editable; 开工 sends it out. */
export function TodoDetail(props: { item: Issue; onDone: (id: string | undefined) => void }) {
  const [d, setD] = createSignal(untrack(() => draftOf(props.item)));
  // Until the owner edits a field, a draft coming back fills them.
  const [edited, setEdited] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [word, setWord] = createSignal("");
  const [newProject, setNewProject] = createSignal(false);
  const workAgents = useWorkAgents();
  const agents = () => workAgents().filter((a) => a.enabled);
  const projectList = useProjects();
  const projects = () => ready(projectList, []).map((p) => p.name);

  // The issue as the server has it now replaces the draft, unless the owner has started changing it.
  createEffect(
    () => draftOf(props.item),
    (fresh) => {
      if (!untrack(edited)) setD(fresh);
    },
    { defer: true },
  );

  const edit = (change: Partial<Draft>) => {
    setD((x) => ({ ...x, ...change }));
    setEdited(true);
  };

  const update = (x: Draft): IssueUpdate => {
    return {
      title: x.title,
      description: x.description,
      project: x.project,
      assignee: x.agent,
      priority: x.priority,
      review: x.acceptance,
      criteria: criteriaList(x.criteria),
    };
  };

  // Saving goes with the act (edit): the server saves the fields before it acts on them. Taken when asked, so a call
  // that waits does not read them later.
  const unsaved = (): IssueUpdate | undefined => {
    if (!edited()) return undefined;
    const x = d();
    rememberPick(x.agent, x.project);
    return update(x);
  };
  const saved = <T,>(got: T) => {
    setEdited(false);
    return got;
  };

  async function busyWith(act: () => Promise<unknown>) {
    setBusy(true);
    await run(act);
    setBusy(false);
  }

  const backlog = () => props.item.status === "backlog";
  const drafting = () => props.item.refining;
  const refined = () => isRefined(props.item);
  const questions = () => props.item.questions;
  const queued = () => props.item.queuedAt;
  const canSave = () => !busy() && d().title.trim() !== "";
  const canRefine = () => !busy() && !drafting() && (refined() || word().trim() !== "" || d().title.trim() !== newIssueTitle);
  const startable = () => canSave() && !drafting() && d().agent !== "";
  const said = (): [string, string] => {
    const by = drafting();
    return by
      ? [`${by.name}在起草`, "它在读代码，写好了会填进下面各栏。"]
      : questions().length > 0
        ? [`草稿写好了，它有 ${questions().length} 个问题要问你`, "在下面回答，它照你的回答再起草一版。"]
        : refined()
          ? ["草稿写好了", "看一遍、改一改，没问题就开工。"]
          : ["想做什么？", "写一句就行：帮工读过代码，替你写成工单。"];
  };

  const draft = () => {
    const id = props.item.id;
    const text = word().trim();
    const edit = unsaved();
    return busyWith(async () => {
      saved(await api.issue.refine({ id, body: { text, edit } }));
      setWord("");
    });
  };
  const start = () => {
    const id = props.item.id;
    const x = d();
    rememberPick(x.agent, x.project);
    const told = dispatchedNotice(props.onDone);
    return busyWith(async () => {
      told(saved(await api.issue.status({ id, body: { status: "todo", edit: update(x) } })));
    });
  };
  const tryNow = () => {
    const id = props.item.id;
    const edit = unsaved();
    const done = props.onDone;
    return busyWith(async () => {
      const got = saved(await api.issue.dispatch({ id, body: { edit } }));
      if (got.queued) throw new Error(got.queued);
      done(id);
    });
  };
  const unqueue = () => {
    const id = props.item.id;
    return busyWith(() => api.issue.status({ id, body: { status: "backlog" } }));
  };
  const remove = () => {
    const id = props.item.id;
    const done = props.onDone;
    return busyWith(async () => {
      await api.issue.delete({ id });
      done(undefined);
    });
  };

  const criteria = () => criteriaList(d().criteria);
  const heading = (
    <div>
      <Show when={backlog()}>
        <div class="mb-4 pr-10">
          <Stages at="talk" />
        </div>
      </Show>
      <input
        value={d().title}
        onInput={(e) => edit({ title: e.currentTarget.value })}
        placeholder="比如：给登录页加上记住我"
        aria-label="标题"
        class="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-xl font-semibold outline-none placeholder:text-faint hover:border-line focus:border-focus"
      />
    </div>
  );

  const main = (
    <>
      <textarea
        value={d().description}
        onInput={(e) => edit({ description: e.currentTarget.value })}
        rows={6}
        placeholder="说明：为什么、要做的、不做的、可能涉及哪些文件（起草会写好）"
        aria-label="说明"
        class="w-full resize-y rounded-md border border-transparent bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-faint hover:border-line focus:border-focus"
      />
      <div class="mt-3 border-t border-line">
        <Fold label="验收标准" summary={criteria().length === 0 ? "还没写" : `${criteria().length} 条 · ${criteria()[0]}`} open={criteria().length === 0}>
          <TextArea
            rows={3}
            value={d().criteria}
            onInput={(e) => edit({ criteria: e.currentTarget.value })}
            placeholder="一行一条：你验收时照着看的点"
            aria-label="验收标准"
          />
        </Fold>
      </div>
      <Show when={backlog()}>
        <SheetLabel>和帮工聊清楚</SheetLabel>
        <Note tone={drafting() ? "water" : "wheat"}>
          <div class="text-base font-semibold">{said()[0]}</div>
          <div class="mt-1">{said()[1]}</div>
          <For each={questions()}>
            {(a) => (
              <div class="mt-1.5">
                <div>· {a.question}</div>
                <Show when={a.options?.length}>
                  <div class="mt-1 flex flex-wrap gap-1.5 pl-3" role="group" aria-label={`回答：${a.question}`}>
                    <For each={a.options}>
                      {(o) => (
                        <Button disabled={busy()} onClick={() => setWord(o)}>
                          {o}
                        </Button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Note>
        <TextArea
          class="mt-2.5"
          rows={2}
          value={word()}
          onInput={(e) => setWord(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing && canRefine()) {
              e.preventDefault();
              void draft();
            }
          }}
          placeholder={questions().length > 0 ? "回答它的问题" : refined() ? "再起草时要它改什么（可以不写）" : "想做什么，一句话就行"}
          aria-label="想做什么"
        />
        <div class="mt-2.5">
          <Button tone={refined() ? "plain" : "primary"} disabled={!canRefine()} onClick={() => void draft()}>
            {refined() ? "再起草" : "起草"}
          </Button>
        </div>
      </Show>
    </>
  );

  const side = (
    <>
      <Property label="状态">
        <span class="flex items-center gap-2">
          <span class={["size-2 rounded-full", backlog() ? "bg-wheat" : "bg-water"]} />
          {backlog() ? "草稿" : "待办"}
        </span>
      </Property>
      <Property label="帮工">
        <Pick
          label="帮工"
          value={d().agent}
          placeholder="起草时替你挑"
          onChange={(v) => edit({ agent: v })}
          options={agents().map((a) => ({ value: a.id, label: a.runtime ? `${a.name} · ${a.runtime}` : a.name }))}
        />
      </Property>
      <Property label="项目">
        <Pick
          label="项目"
          value={d().project}
          placeholder="在哪个项目里做"
          onChange={(v) => edit({ project: v })}
          options={[...new Set([...projects(), ...(d().project ? [d().project] : [])])].map((p) => ({ value: p, label: p }))}
        />
      </Property>
      <button type="button" onClick={() => setNewProject(true)} class="mb-1 ml-[76px] cursor-pointer self-start text-xs text-water hover:underline">
        {projects().length === 0 ? "还没有项目：新建一个" : "＋ 新建项目"}
      </button>
      <Property label="优先级">
        <Pick
          label="优先级"
          value={d().priority}
          onChange={(v) => edit({ priority: v as Priority })}
          options={PriorityValues.map((p) => ({ value: p, label: priorityLabel[p] }))}
        />
      </Property>
      <More>
        {/* Every issue has an acceptance; this is who must pass it before the harvest. */}
        <Property label="验收">
          <Pick
            label="验收"
            value={d().acceptance}
            onChange={(v) => edit({ acceptance: v as Review })}
            options={[
              { value: "glance", label: "看一眼就收" },
              { value: "required", label: "必须过验收" },
            ]}
          />
        </Property>
        <Property label="写于">{wallClockText(props.item.createdAt)}</Property>
      </More>
      <Show when={queued()}>
        {(at) => (
          <Note tone="water" class="mt-2 !p-2.5">
            <div>排队中：{ago(at(), Date.now())}排上的，有空地就按看板上的先后自动开工。</div>
            <Button class="mt-1.5" disabled={busy()} onClick={() => void unqueue()}>
              不排了
            </Button>
          </Note>
        )}
      </Show>
      <div class="mt-4 flex flex-col gap-2">
        <Show when={backlog()}>
          <Button tone={refined() ? "primary" : "plain"} disabled={!startable()} title={d().agent ? undefined : "先选好帮工"} onClick={() => void start()}>
            开工
          </Button>
        </Show>
        <Show when={queued() !== undefined}>
          <Button tone="primary" disabled={!canSave() || !d().agent} onClick={() => void tryNow()}>
            现在就试
          </Button>
        </Show>
        <Button
          disabled={!canSave() || !edited()}
          onClick={() => {
            const id = props.item.id;
            const edit = unsaved();
            if (edit) void busyWith(async () => saved(await api.issue.update({ id, body: edit })));
          }}
        >
          存下改动
        </Button>
        <Button tone="quiet" disabled={busy()} onClick={() => void remove()}>
          删掉
        </Button>
      </div>
      <Show when={newProject()}>
        <NewProjectDialog
          onClose={() => setNewProject(false)}
          onMade={(name) => {
            setNewProject(false);
            edit({ project: name });
          }}
        />
      </Show>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

function NewProjectDialog(props: { onClose: () => void; onMade: (name: string) => void }) {
  const [name, setName] = createSignal("");
  const make = async () => {
    const wanted = name().trim();
    const made = await run(() => api.project.create({ body: { name: wanted } }));
    if (!made) return;
    await queries.invalidateQueries({ queryKey: ["projects"] });
    props.onMade(made.name);
  };
  return (
    <Dialog open onClose={props.onClose} title="新建项目">
      <TextInput
        ref={autofocus()}
        value={name()}
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Enter" && name().trim() && void make()}
        placeholder="项目名，也是工作目录下的文件夹名"
        aria-label="项目名"
      />
      <div class="mt-5 flex justify-end gap-2">
        <Button onClick={() => props.onClose()}>算了</Button>
        <Button tone="primary" disabled={!name().trim()} onClick={() => void make()}>
          新建
        </Button>
      </div>
    </Dialog>
  );
}
