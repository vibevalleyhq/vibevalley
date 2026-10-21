import { useQuery } from "@tanstack/react-query";
import type { Acceptance, Issue, Session, SessionEvent } from "@vibevalley/protocol";
import { useState } from "react";
import { api } from "../../data/api";
import { useAgents } from "../../data/agents";
import type { Tone } from "../../rules/cards";
import { type IssueTag, issueTag, stageOf, tagLabel, tagOpen, runText } from "../../rules/issues";
import { actLabel, bugText, changesLine, findingsOf, type IssueOffer, issueState, noStepsText, resumeWords } from "../../rules/issueState";
import { tookText, wallClockText } from "../../rules/time";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { TextArea } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { ChangesBody, ChangesHead } from "./CloseDialog";
import { newSendKey, useRun } from "./data";
import { useGraphs } from "./hooks";
import { Fold, More, Note, Pick, Property, Stages, IssueSheet } from "./Sheet";

export const tagTone: Record<IssueTag, Tone> = {
  working: "water",
  waiting: "wheat",
  harvested: "leaf",
  merged: "leaf",
  answered: "leaf",
  dropped: "faint",
  closed: "faint",
  lost: "berry",
};

const Dot = ({ tone }: { tone: Tone }) => <span className="size-2 shrink-0 rounded-full" style={{ background: `var(--color-${tone})` }} />;

/** The workbench's issue page: the status and what it needs first, the rest folded. `onClose` opens the close dialog
 * (`review`: straight on the harvest checklist). */
export function IssueDetail({
  issue,
  sessions,
  tag,
  session,
  onClose,
  onTask,
}: {
  issue: Issue;
  sessions: Session[];
  tag: IssueTag;
  session?: Session;
  onClose: (session: Session, review: boolean) => void;
  onTask?: () => void;
}) {
  const graphs = useGraphs();
  const s = issueState(issue, sessions, tag, session, graphs);
  const head = s.head;
  const run = useRun();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const agent = useAgents().data?.find((a) => a.id === head.agent);
  const steps = useQuery({
    queryKey: ["issues", "events", head.id, head.runs, head.phase._tag],
    queryFn: () => api.session.events({ id: head.id }),
    placeholderData: (prev) => prev,
  }).data;
  const changes = useQuery({ queryKey: ["issues", "changes", issue.id], queryFn: () => api.issue.changes({ id: issue.id }), enabled: s.showsChanges });

  async function act(f: () => Promise<unknown>) {
    setBusy(true);
    const done = await run(async () => {
      await f();
      return true;
    });
    setBusy(false);
    return done;
  }

  const tell = () => {
    const words = text.trim();
    if (!words || !session) return;
    void act(() => api.issue.comment({ id: issue.id, body: { text: words, sendKey: newSendKey() } })).then((ok) => ok && setText(""));
  };

  const reopen = async () => {
    setBusy(true);
    const got = await run(() => api.issue.status({ id: issue.id, body: { status: "todo", text: text.trim() } }));
    setBusy(false);
    const last = got?.sessions[got.sessions.length - 1];
    if (last) {
      setText("");
      toast(`工单重开了：${last} 接着做。`);
    }
  };

  // A pass, or a fail whose findings are what the box says: one weed a line.
  const accept = async (pass: boolean) => {
    if (pass) return void act(() => api.issue.accept({ id: issue.id, body: { pass: true } }));
    const lines = findingsOf(text);
    if (lines.length === 0) return;
    if (await act(() => api.issue.accept({ id: issue.id, body: { pass: false, findings: lines } }))) setText("");
  };

  const offer = (o: IssueOffer, h: Session) => {
    const go = {
      stop: () => act(() => api.session.stop({ id: h.id })),
      resolve: () => act(() => api.issue.resolve({ id: issue.id })),
      resume: () => act(() => api.issue.comment({ id: issue.id, body: { text: resumeWords } })),
      harvest: () => onClose(h, true),
      cure: () => act(() => api.issue.comment({ id: issue.id, body: { text: bugText(h.brief) } })),
      close: () => onClose(h, false),
    }[o.act];
    return (
      // Only the lead is filled; 关上 asks again in its own dialog, so it need not shout here.
      <Button key={o.act} tone={o.lead ? "primary" : "plain"} disabled={busy} onClick={() => void go()} className="justify-center">
        {actLabel[o.act]}
      </Button>
    );
  };

  const heading = (
    <div>
      <div className="mb-4 pr-10">
        <Stages at={stageOf(issue.status)} />
      </div>
      {s.inTask && onTask && (
        <button type="button" onClick={onTask} className="mb-1.5 cursor-pointer px-2 text-xs text-water hover:underline">
          ‹ {graphs.find((g) => g.id === issue.parent)?.title ? `计划「${graphs.find((g) => g.id === issue.parent)!.title}」的一步` : "回到计划"}
        </button>
      )}
      <h1 className="px-2 text-xl font-semibold">{s.title}</h1>
      {s.description && s.description !== s.title && <Markdown className="mt-2 px-2 text-sm text-ink/90" text={s.description} />}
    </div>
  );

  const status = s.status;
  const main = (
    <>
      <Note tone={status.tone}>
        <div className="text-base font-semibold">{status.head}</div>
        {status.line && <div className="mt-1 line-clamp-4">{status.line}</div>}
        {status.list.map((a) => (
          <div key={a}>· {a}</div>
        ))}
        {s.inTask && <div className="mt-1.5 text-xs text-muted">{s.taskText}</div>}
      </Note>
      {s.weeds.length > 0 && (
        <div className="mt-2.5">
          {s.weeds.map((f) => (
            <div key={f.id} className="text-sm text-berry">
              草 · {f.text}
            </div>
          ))}
        </div>
      )}
      {(issue.criteria ?? []).length > 0 && (
        <div className="mt-3 border-t border-line">
          {/* Folded to its count; it opens itself when the work comes back for review, to be ticked one by one. */}
          <Fold label="验收标准" summary={`${issue.criteria!.length} 条 · ${issue.criteria![0]}`} open={s.judging}>
            <Criteria criteria={issue.criteria!} checking={s.judging} />
          </Fold>
        </div>
      )}
      {s.hasBox && (
        <div className="mt-4">
          <TextArea
            rows={s.judging ? 3 : 2}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && s.enterSends && s.talking) {
                e.preventDefault();
                tell();
              }
            }}
            placeholder={s.placeholder}
            aria-label={s.boxLabel}
          />
          <div className="mt-2.5 flex flex-wrap gap-2">
            {s.talking && (
              <Button icon="button-send" disabled={busy || !text.trim()} onClick={tell}>
                带话
              </Button>
            )}
            {s.judging && (
              <>
                <Button tone="primary" disabled={busy} onClick={() => accept(true)}>
                  验收通过
                </Button>
                <Button tone="danger" disabled={busy || !text.trim()} onClick={() => accept(false)}>
                  没过，照上面修
                </Button>
              </>
            )}
            {s.reopening && (
              <Button tone="primary" disabled={busy} onClick={reopen}>
                重开
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="mt-5 border-t border-line">
        {s.showsChanges && (
          <Fold label="改动" summary={changes.data ? changesLine(changes.data) : undefined}>
            {changes.data ? (
              <div className="flex flex-col gap-2">
                <ChangesHead changes={changes.data} />
                {changes.data.conflicts.length > 0 && (
                  <div className="text-sm text-berry">
                    合进 {changes.data.base} 会冲突：{changes.data.conflicts.join("、")}
                  </div>
                )}
                <ChangesBody changes={changes.data} />
              </div>
            ) : (
              <p className="text-sm text-muted">{changes.isPending ? "在读……" : "读不到改动。"}</p>
            )}
          </Fold>
        )}
        <Fold label="干活过程" summary={steps?.length ? stepsLine(steps) : undefined}>
          {steps?.length ? <WorkLog steps={steps} /> : <p className="text-xs text-faint">{noStepsText(head)}</p>}
        </Fold>
        <Fold label="每次干活" summary={s.historyLine}>
          <Runs issue={issue.id} version={`${tag}:${session?.runs}:${session?.phase._tag}`} />
        </Fold>
      </div>
    </>
  );

  const offers = session ? s.offers.map((o) => offer(o, session)) : [];
  const side = (
    <>
      {offers.length > 0 && <div className="mb-3 flex flex-col gap-2">{offers}</div>}
      <Property label="状态">
        <span className="flex items-center gap-2">
          <Dot tone={tagTone[tag]} />
          {tagLabel[tag]}
        </span>
      </Property>
      <Property label="谁在做">{s.whoLine}</Property>
      {s.project && <Property label="项目">{s.project}</Property>}
      {s.acceptanceEditable && (
        <Property label="验收">
          <Pick
            label="验收"
            value={issue.acceptance}
            disabled={busy || !s.open}
            onChange={(v) => void act(() => api.issue.update({ id: issue.id, body: { acceptance: v as Acceptance } }))}
            options={[
              { value: "glance", label: "看一眼就收" },
              { value: "required", label: "必须过验收" },
            ]}
          />
        </Property>
      )}
      {issue.acceptedAt !== undefined && (
        <Property label="验收过">
          <span className="text-accent">{wallClockText(issue.acceptedAt)}</span>
        </Property>
      )}
      <More>
        {s.crewLine && <Property label="地上的人">{s.crewLine}</Property>}
        {agent?.model && <Property label="模型">{agent.model}</Property>}
        <Property label="档案">{agent?.name ?? head.name}</Property>
        {head.branch && (
          <Property label="分支">
            <span className="font-mono text-xs">{head.branch}</span>
          </Property>
        )}
        {head.worktree && (
          <Property label="worktree">
            <span className="flex items-start gap-1">
              <span className="min-w-0 flex-1 font-mono text-xs break-all select-text">{head.worktree}</span>
              <button
                type="button"
                aria-label="复制路径"
                title="复制路径"
                onClick={() => void navigator.clipboard?.writeText(head.worktree!)}
                className="cursor-pointer rounded p-0.5 hover:bg-hover"
              >
                <Icon name="button-copy" size={14} />
              </button>
            </span>
          </Property>
        )}
        <Property label="开单">{wallClockText(issue.createdAt)}</Property>
        {issue.closedAt !== undefined && <Property label="关单">{wallClockText(issue.closedAt)}</Property>}
        <Property label="做过">{s.historyLine}</Property>
        <Property label="用时">{s.usedLine(steps ?? [], Date.now())}</Property>
        {s.pulled.length > 0 && (
          <Property label="拔了的草">
            {s.pulled.map((f) => (
              <div key={f.id} className="text-faint line-through">
                {f.text}
              </div>
            ))}
          </Property>
        )}
      </More>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

/** The criteria; while it is judged, each can be ticked off as the owner checks it (on this page only). */
function Criteria({ criteria, checking }: { criteria: string[]; checking: boolean }) {
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  if (!checking)
    return (
      <ul className="text-sm">
        {criteria.map((c, i) => (
          <li key={i}>· {c}</li>
        ))}
      </ul>
    );
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-muted">照验收标准看，看过一条勾一条</div>
      {criteria.map((c, i) => (
        <label key={i} className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 text-sm hover:bg-hover">
          <input
            type="checkbox"
            checked={ticked.has(i)}
            onChange={() =>
              setTicked((t) => {
                const n = new Set(t);
                if (n.has(i)) n.delete(i);
                else n.add(i);
                return n;
              })
            }
            className="mt-0.5 size-4 accent-leaf"
          />
          <span className={ticked.has(i) ? "text-muted" : ""}>{c}</span>
        </label>
      ))}
    </div>
  );
}

/** The runs of an issue, read again whenever `version` changes. */
function Runs({ issue, version }: { issue: string; version: string }) {
  const runs =
    useQuery({ queryKey: ["issues", "runs", issue, version], queryFn: () => api.issue.runs({ id: issue }), placeholderData: (prev) => prev }).data ?? [];
  if (runs.length === 0) return <p className="text-xs text-faint">还没有干过活。</p>;
  const now = Date.now();
  return (
    <div>
      <div className="mb-2 text-xs text-muted">{runs.length} 次</div>
      {[...runs].reverse().map((r) => (
        <div key={r.id} className="flex gap-3 pb-2 text-sm">
          <span className="w-20 shrink-0 text-muted">{wallClockText(r.startedAt)}</span>
          <span className="min-w-0 flex-1">
            {runText(r, now, tookText)}
            {r.summary && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{r.summary}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

const stepsLine = (steps: SessionEvent[]) => {
  const tools = steps.filter((e) => e.type === "tool/call").length;
  return tools === 0 ? `${steps.length} 步` : `${steps.length} 步 · 用了 ${tools} 个工具`;
};

const stepWord: Partial<Record<SessionEvent["type"], string>> = {
  "run/start": "开工",
  "user/message": "听到",
  "memory/recalled": "想起",
  "assistant/thinking": "想",
  "assistant/message": "说",
  "tool/call": "用工具",
  "llm/retry": "重试",
  "run/error": "出错",
  "run/end": "收工",
};

/** The session's steps, newest last; tool results and usage are left to the farm's fuller log. */
function WorkLog({ steps }: { steps: SessionEvent[] }) {
  const shown = steps.filter((e) => stepWord[e.type] !== undefined).slice(-240);
  return (
    <ol className="max-h-[420px] overflow-y-auto font-mono text-xs">
      {shown.map((e) => (
        <li key={e.seq} className="flex gap-2.5 border-b border-line/60 py-1 last:border-b-0">
          <span className="w-14 shrink-0 text-faint">{wallClockText(e.time)}</span>
          <span className={`w-12 shrink-0 ${e.type === "run/error" ? "text-berry" : e.type === "tool/call" ? "text-water" : "text-muted"}`}>
            {stepWord[e.type]}
          </span>
          <span className="line-clamp-3 min-w-0 flex-1 font-sans text-sm break-words whitespace-pre-wrap">
            {e.type === "tool/call" ? (e.actionText ?? e.text) : e.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** An issue for the manager: what it was asked, and its runs; the answers are in its channel. */
export function ManagerIssueDetail({ issue }: { issue: Issue }) {
  const tag = issueTag(issue);
  return (
    <div>
      <div className="flex items-start gap-3 pr-10">
        <h1 className="flex-1 text-xl font-semibold">{issue.title}</h1>
        <span className="mt-1.5 text-xs text-muted">{tagLabel[tag]}</span>
      </div>
      <div className="mt-4">
        <Property label="谁在做">管家</Property>
        {issue.description && (
          <Property label="要做的">
            <span className="text-base">{issue.description}</span>
          </Property>
        )}
        {issue.schedule && <Property label="来自">定时：每次到点重开这张工单，管家答完就关上</Property>}
        <Property label="开单">{wallClockText(issue.createdAt)}</Property>
        {issue.closedAt !== undefined && <Property label="关单">{wallClockText(issue.closedAt)}</Property>}
        <Property label="回答">在它的频道里</Property>
      </div>
      <h2 className="mt-5 mb-2 text-sm font-semibold">每次干活</h2>
      <Runs issue={issue.id} version={`${issue.status}:${issue.closedAt}:${tagOpen(tag)}`} />
    </div>
  );
}
