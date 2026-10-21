import type { Acceptance, Issue, IssueUpdate, Priority } from "@vibevalley/protocol";
import { PriorityValues } from "@vibevalley/protocol";
import { useEffect, useState } from "react";
import { api, queries } from "../../data/api";
import { useWorkAgents } from "../../data/agents";
import { isDrafted, newIssueTitle, priorityLabel } from "../../rules/issues";
import { ago, wallClockText } from "../../rules/time";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TextArea, TextInput } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { rememberPick, useProjectNames, useRun } from "./data";
import { Fold, More, Note, Pick, Property, SheetLabel, Stages, IssueSheet } from "./Sheet";

interface Draft {
  title: string;
  description: string;
  criteria: string;
  project: string;
  agent: string;
  priority: Priority;
  acceptance: Acceptance;
}

const draftOf = (i: Issue): Draft => ({
  title: i.title,
  description: i.description ?? "",
  criteria: (i.criteria ?? []).join("\n"),
  project: i.project ?? "",
  agent: i.assignee ?? "",
  priority: i.priority,
  acceptance: i.acceptance,
});

const criteriaList = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Moved to todo: it is either worked already, or waits there for room. */
export function useDispatchedNotice(open: (id: string | undefined) => void) {
  const toast = useToast();
  return (got: Issue) => {
    if (got.status === "todo") toast("排上队了：地都满了，有空地就自动开工。");
    else open(got.id);
  };
}

/** An issue not sent yet. In the backlog it is a draft: the box says what is wanted (or answers what its drafter asked)
 * and sends a helper to draft it; the fields are the draft, each editable; 开工 sends it out. */
export function TodoDetail({ item, onDone }: { item: Issue; onDone: (id: string | undefined) => void }) {
  const [d, setD] = useState(() => draftOf(item));
  // Until the owner edits a field, a draft coming back fills them.
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [word, setWord] = useState("");
  const [newProject, setNewProject] = useState(false);
  const run = useRun();
  const notice = useDispatchedNotice(onDone);
  const agents = useWorkAgents().filter((a) => a.enabled);
  const projects = useProjectNames();

  const itemKey = JSON.stringify(item);
  useEffect(() => {
    if (!edited) setD(draftOf(item));
  }, [itemKey]);

  const edit = (change: Partial<Draft>) => {
    setD((x) => ({ ...x, ...change }));
    setEdited(true);
  };

  const update = (): IssueUpdate => ({
    title: d.title,
    description: d.description,
    project: d.project,
    assignee: d.agent,
    priority: d.priority,
    acceptance: d.acceptance,
    criteria: criteriaList(d.criteria),
  });

  async function save() {
    const got = await api.issue.update({ id: item.id, body: update() });
    rememberPick(d.agent, d.project);
    setEdited(false);
    return got;
  }

  async function busyWith(act: () => Promise<unknown>) {
    setBusy(true);
    await run(act);
    setBusy(false);
  }

  const backlog = item.status === "backlog";
  const drafting = item.drafting;
  const drafted = isDrafted(item);
  const asks = item.asks;
  const queued = item.queuedAt;
  const ready = !busy && d.title.trim() !== "";
  const canDraft = !busy && !drafting && (drafted || word.trim() !== "" || d.title.trim() !== newIssueTitle);
  const startable = ready && !drafting && d.agent !== "";
  const [head, line] = drafting
    ? [`${drafting.name}在起草`, "它在读代码，写好了会填进下面各栏。"]
    : asks.length > 0
      ? [`草稿写好了，它有 ${asks.length} 个问题要问你`, "在下面回答，它照你的回答再起草一版。"]
      : drafted
        ? ["草稿写好了", "看一遍、改一改，没问题就开工。"]
        : ["想做什么？", "写一句就行：帮工读过代码，替你写成工单。"];

  const draft = () =>
    busyWith(async () => {
      if (edited) await save();
      await api.issue.draft({ id: item.id, body: { text: word.trim() } });
      setWord("");
    });

  const criteria = criteriaList(d.criteria);
  const heading = (
    <div>
      {backlog && (
        <div className="mb-4 pr-10">
          <Stages at="talk" />
        </div>
      )}
      <input
        value={d.title}
        onChange={(e) => edit({ title: e.target.value })}
        placeholder="比如：给登录页加上记住我"
        aria-label="标题"
        className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-xl font-semibold outline-none placeholder:text-faint hover:border-line focus:border-focus"
      />
    </div>
  );

  const main = (
    <>
      <textarea
        value={d.description}
        onChange={(e) => edit({ description: e.target.value })}
        rows={6}
        placeholder="说明：为什么、要做的、不做的、可能涉及哪些文件（起草会写好）"
        aria-label="说明"
        className="w-full resize-y rounded-md border border-transparent bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-faint hover:border-line focus:border-focus"
      />
      <div className="mt-3 border-t border-line">
        <Fold label="验收标准" summary={criteria.length === 0 ? "还没写" : `${criteria.length} 条 · ${criteria[0]}`} open={criteria.length === 0}>
          <TextArea
            rows={3}
            value={d.criteria}
            onChange={(e) => edit({ criteria: e.target.value })}
            placeholder="一行一条：你验收时照着看的点"
            aria-label="验收标准"
          />
        </Fold>
      </div>
      {backlog && (
        <>
          <SheetLabel>和帮工聊清楚</SheetLabel>
          <Note tone={drafting ? "water" : "wheat"}>
            <div className="text-base font-semibold">{head}</div>
            <div className="mt-1">{line}</div>
            {asks.map((a) => (
              <div key={a}>· {a}</div>
            ))}
          </Note>
          <TextArea
            className="mt-2.5"
            rows={2}
            value={word}
            onChange={(e) => setWord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && canDraft) {
                e.preventDefault();
                void draft();
              }
            }}
            placeholder={asks.length > 0 ? "回答它的问题" : drafted ? "再起草时要它改什么（可以不写）" : "想做什么，一句话就行"}
            aria-label="想做什么"
          />
          <div className="mt-2.5">
            <Button tone={drafted ? "plain" : "primary"} disabled={!canDraft} onClick={draft}>
              {drafted ? "再起草" : "起草"}
            </Button>
          </div>
        </>
      )}
    </>
  );

  const side = (
    <>
      <Property label="状态">
        <span className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${backlog ? "bg-wheat" : "bg-water"}`} />
          {backlog ? "草稿" : "待办"}
        </span>
      </Property>
      <Property label="帮工">
        <Pick
          label="帮工"
          value={d.agent}
          placeholder="起草时替你挑"
          onChange={(v) => edit({ agent: v })}
          options={agents.map((a) => ({ value: a.id, label: a.runtime ? `${a.name} · ${a.runtime}` : a.name }))}
        />
      </Property>
      <Property label="项目">
        <Pick
          label="项目"
          value={d.project}
          placeholder="在哪个项目里做"
          onChange={(v) => edit({ project: v })}
          options={[...new Set([...projects, ...(d.project ? [d.project] : [])])].map((p) => ({ value: p, label: p }))}
        />
      </Property>
      <button type="button" onClick={() => setNewProject(true)} className="mb-1 ml-[76px] cursor-pointer self-start text-xs text-water hover:underline">
        {projects.length === 0 ? "还没有项目：新建一个" : "＋ 新建项目"}
      </button>
      <Property label="优先级">
        <Pick
          label="优先级"
          value={d.priority}
          onChange={(v) => edit({ priority: v as Priority })}
          options={PriorityValues.map((p) => ({ value: p, label: priorityLabel[p] }))}
        />
      </Property>
      <More>
        {/* Every issue has an acceptance; this is who must pass it before the harvest. */}
        <Property label="验收">
          <Pick
            label="验收"
            value={d.acceptance}
            onChange={(v) => edit({ acceptance: v as Acceptance })}
            options={[
              { value: "glance", label: "看一眼就收" },
              { value: "required", label: "必须过验收" },
            ]}
          />
        </Property>
        <Property label="写于">{wallClockText(item.createdAt)}</Property>
      </More>
      {queued !== undefined && (
        <Note tone="water" className="mt-2 !p-2.5">
          <div>排队中：{ago(queued, Date.now())}排上的，有空地就按看板上的先后自动开工。</div>
          <Button className="mt-1.5" disabled={busy} onClick={() => busyWith(() => api.issue.status({ id: item.id, body: { status: "backlog" } }))}>
            不排了
          </Button>
        </Note>
      )}
      <div className="mt-4 flex flex-col gap-2">
        {backlog && (
          <Button
            tone={drafted ? "primary" : "plain"}
            disabled={!startable}
            title={d.agent ? undefined : "先选好帮工"}
            onClick={() =>
              busyWith(async () => {
                await save();
                notice(await api.issue.status({ id: item.id, body: { status: "todo" } }));
              })
            }
          >
            开工
          </Button>
        )}
        {queued !== undefined && (
          <Button
            tone="primary"
            disabled={!ready || !d.agent}
            onClick={() =>
              busyWith(async () => {
                if (edited) await save();
                const got = await api.issue.dispatch({ id: item.id, body: {} });
                if (got.queued) throw new Error(got.queued);
                onDone(item.id);
              })
            }
          >
            现在就试
          </Button>
        )}
        <Button disabled={!ready || !edited} onClick={() => busyWith(save)}>
          存下改动
        </Button>
        <Button
          tone="quiet"
          disabled={busy}
          onClick={() =>
            busyWith(async () => {
              await api.issue.delete({ id: item.id });
              onDone(undefined);
            })
          }
        >
          删掉
        </Button>
      </div>
      {newProject && (
        <NewProjectDialog
          onClose={() => setNewProject(false)}
          onMade={(name) => {
            setNewProject(false);
            edit({ project: name });
          }}
        />
      )}
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

function NewProjectDialog({ onClose, onMade }: { onClose: () => void; onMade: (name: string) => void }) {
  const [name, setName] = useState("");
  const run = useRun();
  const make = async () => {
    const made = await run(() => api.project.create({ body: { name: name.trim() } }));
    if (!made) return;
    await queries.invalidateQueries({ queryKey: ["projects"] });
    onMade(made.name);
  };
  return (
    <Dialog open onClose={onClose} title="新建项目">
      <TextInput
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && name.trim() && void make()}
        placeholder="项目名，也是工作目录下的文件夹名"
        aria-label="项目名"
      />
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>算了</Button>
        <Button tone="primary" disabled={!name.trim()} onClick={make}>
          新建
        </Button>
      </div>
    </Dialog>
  );
}
