// A plot's issue, opened by clicking the plot or its helper: the helper
// standing on its crop at the side; the stages, the title and one box that says how it is now, the weeds, the criteria
// (ticked off while it is judged), one box to talk to the helper, judge it or reopen it, and the offers (stop, resolve,
// go on, harvest, fix, close); folded under it the changes, the work log, each run and the details. What it says and
// offers is src/rules/issueState.ts, the server's state read; the workbench draws the same issue as its own page.

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { Acceptance, Agent, Issue, Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useAgents } from "../../data/agents";
import { useCore, useFrames } from "../../data/frame";
import { issueThreadOf } from "../../rules/chat";
import { changesLine, findingsOf, type IssueOffer, issueState, noStepsText, resumeWords } from "../../rules/issueState";
import { issueTag, runText, type Stage, stageOf, stages, stageLabel, tagLabel } from "../../rules/issues";
import { tookText, wallClockText } from "../../rules/time";
import { useIssueHistory } from "../../pages/issues/data";
import { useSessionEvents } from "../../pages/chat/data";
import { WorkLog } from "../../pages/chat/WorkLog";
import { castPrefix } from "../../ui/Face";
import { FarmDialog, FarmSection, PxButton, PxTextArea, SpriteIcon, toasts, ToastType } from "../kit";
import { useFarmCommands } from "../commands";
import { farm, overlayOf, useFarm } from "../store";
import { useVillage } from "../world/load";
import { cropLabel, issueOf, plotOf, stationOfSession } from "../world/plots";
import { tint } from "../panels/bits";

const tones: Record<string, string> = { berry: "#c84a3a", wheat: "#e5a93c", water: "#4f8fbd", leaf: "#74a046", faint: "#c8a46e", muted: "#9b7550" };
const body = "text-[13px] leading-[1.5] text-bark-800";
const xs = "text-[12px] text-bark-600";

const speciesLabel: Record<string, string> = { bear: "熊", rabbit: "兔子", fox: "小狐狸", cat: "猫", owl: "猫头鹰", hedgehog: "刺猬", raccoon: "浣熊" };
const outfitLabel: Record<string, string> = { farmer: "农夫", gardener: "园丁", rain: "雨衣", winter: "冬装" };

/** The plot's issue while the store says so (the inspect layer). */
export function IssueView() {
  const inspect = useFarm((s) => overlayOf(s, "inspect"));
  const core = useCore();
  if (!inspect) return null;
  const session = core?.sessions.find((s) => s.id === inspect.sessionId);
  if (!session) return null;
  return (
    <FarmDialog title={`${session.name}的地`} size="lg" onClose={() => farm.select(null)}>
      <PlotDetail session={session} onDone={() => farm.select(null)} />
    </FarmDialog>
  );
}

function PlotDetail({ session, onDone }: { session: Session; onDone: () => void }) {
  const core = useCore();
  const navigate = useNavigate();
  const history = useIssueHistory(true).rows;
  const id = issueOf(session);
  const issue = core?.issues?.find((i) => i.id === id);
  const sessions = history?.find((h) => h.issue.id === id)?.sessions ?? [session];
  const hasThread = issueThreadOf(core?.chat, id) !== undefined;
  if (!issue) return <p className={body}>这块地的工单还没读到。</p>;
  return (
    <IssueBody
      issue={issue}
      sessions={sessions.length ? sessions : [session]}
      session={session}
      onHarvest={(s) => {
        farm.review(s.id);
        onDone();
      }}
      onClose={async (s) => {
        await api.issue.status({ id: issueOf(s), body: { status: "canceled" } });
        onDone();
      }}
      onThread={
        hasThread
          ? () => {
              const thread = issueThreadOf(core?.chat, id);
              if (thread) farm.showChat(thread.id);
              onDone();
            }
          : undefined
      }
      onNavigate={() => void navigate(`/issues/${encodeURIComponent(id)}`)}
      onTask={
        session.graph
          ? () => {
              farm.openTaskBoard(session.graph!.id);
              onDone();
            }
          : undefined
      }
    />
  );
}

function IssueBody({
  issue,
  sessions,
  session,
  onHarvest,
  onClose,
  onThread,
  onNavigate,
  onTask,
}: {
  issue: Issue;
  sessions: Session[];
  session: Session;
  onHarvest: (s: Session) => void;
  onClose: (s: Session) => Promise<void>;
  onThread?: () => void;
  onNavigate: () => void;
  onTask?: () => void;
}) {
  const { frame } = useFrames();
  const commands = useFarmCommands();
  const agents = new Map((useAgents().data ?? []).map((a) => [a.id, a]));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const tag = issueTag(issue);
  const s = issueState(issue, sessions, tag, session, frame?.graphs ?? []);
  const { head, status } = s;
  const changes = useQuery({ queryKey: ["issues", "changes", issue.id], queryFn: () => api.issue.changes({ id: issue.id }), enabled: s.showsChanges });
  const steps = useSessionEvents(head.id, true);
  const agent = agents.get(head.agent);
  const now = Date.now();

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
    } catch (e) {
      toasts.add({ type: ToastType.warn, title: "没办成", description: reasonOf(e) });
    } finally {
      setBusy(false);
    }
  };
  const tell = async () => {
    if (!text.trim() || !s.session) return;
    await act(() => commands.water(s.session!, text));
    setText("");
  };
  const reopen = () =>
    act(async () => {
      const got = await api.issue.status({ id: issue.id, body: { status: "todo", text: text.trim() || undefined } });
      const helper = got.sessions.at(-1);
      if (helper) {
        setText("");
        toasts.add({ type: ToastType.info, title: "工单重开了", description: `${helper} 接着做。` });
      }
    });
  const accept = async (pass: boolean) => {
    if (pass) return act(() => api.issue.accept({ id: issue.id, body: { pass: true } }));
    const lines = findingsOf(text);
    if (lines.length === 0) return;
    await act(() => api.issue.accept({ id: issue.id, body: { pass: false, findings: lines } }));
    setText("");
  };
  const setAcceptance = (a: Acceptance) => act(() => api.issue.update({ id: issue.id, body: { acceptance: a } }));
  const offer = (o: IssueOffer, h: Session) => {
    const [label, run] = {
      stop: ["叫停这一轮", () => commands.stop(h.id)],
      resolve: ["让它解决冲突", () => commands.resolve(h)],
      resume: ["接着做", () => commands.water(h, resumeWords)],
      harvest: ["收获", async () => onHarvest(h)],
      cure: ["接着修", () => commands.cure(h)],
      close: ["关上", () => onClose(h)],
    }[o.act] as [string, () => Promise<unknown>];
    return (
      <PxButton key={o.act} tone={o.act === "close" ? "danger" : o.lead ? "primary" : "plain"} disabled={busy} onClick={() => void act(run)}>
        {label}
      </PxButton>
    );
  };
  const actions = [
    ...(s.session ? s.offers.map((o) => offer(o, s.session!)) : []),
    <PxButton key="board" icon="button-open" onClick={onNavigate}>
      在看板上看
    </PxButton>,
  ];

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <Aside session={head} agent={agent} />
      <div className="flex min-w-0 flex-1 flex-col">
        <StageRail at={stageOf(issue.status)} />
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-[16px]">{s.title}</h3>
          <span className={xs}>{tagLabel[tag]}</span>
        </div>
        {s.project && <p className={xs}>{s.project}</p>}
        <div className="mt-3 p-3" style={{ background: tint(tones[status.tone] ?? "#c8a46e", 0.3) }}>
          <p className="text-[14px]">{status.head}</p>
          {status.line && <p className={`mt-1 line-clamp-4 ${body}`}>{status.line}</p>}
          {status.list.map((a) => (
            <p key={a} className={body}>
              · {a}
            </p>
          ))}
          {s.inTask && <p className={`mt-1 ${xs}`}>{s.taskText}</p>}
        </div>
        {s.weeds.length > 0 && (
          <div className="mt-2">
            {s.weeds.map((f) => (
              <p key={f.id} className={`${body} text-berry`}>
                草 · {f.text}
              </p>
            ))}
          </div>
        )}
        {(issue.criteria ?? []).length > 0 && <Criteria criteria={issue.criteria!} checking={s.judging} />}
        {s.hasBox ? (
          <div className="mt-3 flex flex-col gap-2">
            <PxTextArea value={text} onChange={setText} rows={s.judging ? 3 : 2} placeholder={s.placeholder} label={s.boxLabel} disabled={busy} />
            <div className="flex flex-wrap gap-2">
              {s.talking && (
                <PxButton disabled={busy || !text.trim()} onClick={() => void tell()}>
                  带话
                </PxButton>
              )}
              {s.judging && (
                <>
                  <PxButton tone="primary" disabled={busy} onClick={() => void accept(true)}>
                    验收通过
                  </PxButton>
                  <PxButton tone="danger" disabled={busy || !text.trim()} onClick={() => void accept(false)}>
                    没过，照上面修
                  </PxButton>
                </>
              )}
              {s.reopening && (
                <PxButton tone="primary" disabled={busy} onClick={() => void reopen()}>
                  重开
                </PxButton>
              )}
              {actions}
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
        )}
        <div className="mt-4">
          {s.showsChanges && (
            <Fold label={changes.data ? `改动（${changes.data.files.length} 个文件）` : "改动"}>
              {!changes.data ? (
                <p className={body}>{changes.isPending ? "在读……" : "读不到改动。"}</p>
              ) : (
                <div className="flex flex-col">
                  <p className={body}>{changesLine(changes.data)}</p>
                  {changes.data.conflicts.length > 0 && (
                    <p className={`${body} text-berry`}>
                      合进 {changes.data.base} 会冲突：{changes.data.conflicts.join("、")}
                    </p>
                  )}
                  <div className="mt-1.5">
                    {changes.data.files.slice(0, 12).map((f) => (
                      <p key={f.path} className="truncate font-mono text-[11px] text-bark-800">
                        {f.path} +{Math.round(f.added)} -{Math.round(f.removed)}
                      </p>
                    ))}
                    {changes.data.files.length > 12 && <p className={xs}>还有 {changes.data.files.length - 12} 个文件</p>}
                  </div>
                </div>
              )}
            </Fold>
          )}
          <Fold label="干活过程">
            {steps.length === 0 ? <p className={xs}>{noStepsText(head)}</p> : <WorkLog steps={steps} now={now} working={tag === "working"} />}
          </Fold>
          <Fold label="每次干活">
            <Runs issue={issue.id} version={`${issue.sessions.length}:${head.runs}:${head.phase._tag}`} />
          </Fold>
          <Fold label="详情">
            <div className="flex flex-col">
              {s.description && s.description !== s.title && (
                <Row label="要做的">{<p className="whitespace-pre-wrap text-[13px] text-bark-800">{s.description}</p>}</Row>
              )}
              <Row label="谁在做">
                <p className={body}>{s.whoLine}</p>
              </Row>
              {s.crewLine && (
                <Row label="地上的人">
                  <p className={body}>{s.crewLine}</p>
                </Row>
              )}
              {s.acceptanceEditable && (
                <Row label="验收">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(
                      [
                        ["glance", "看一眼就收"],
                        ["required", "必须过验收"],
                      ] as const
                    ).map(([a, label]) => (
                      <PxButton
                        key={a}
                        size="sm"
                        tone={issue.acceptance === a ? "primary" : "plain"}
                        disabled={busy || issue.acceptance === a || !s.open}
                        onClick={() => void setAcceptance(a)}
                      >
                        {label}
                      </PxButton>
                    ))}
                    {issue.acceptedAt !== undefined && <span className="text-[12px] text-leaf-700">已验收 {wallClockText(issue.acceptedAt)}</span>}
                  </div>
                </Row>
              )}
              {s.pulled.length > 0 && (
                <Row label="拔了的草">
                  {s.pulled.map((f) => (
                    <p key={f.id} className={`${body} text-bark-400 line-through`}>
                      已拔 · {f.text}
                    </p>
                  ))}
                </Row>
              )}
              {agent?.model && (
                <Row label="模型">
                  <p className={body}>{agent.model}</p>
                </Row>
              )}
              {head.branch && (
                <Row label="分支">
                  <p className="font-mono text-[12.5px] text-bark-800">{head.branch}</p>
                </Row>
              )}
              {head.worktree && (
                <Row label="worktree">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 font-mono text-[12.5px] break-all select-text">{head.worktree}</span>
                    <PxButton size="sm" onClick={() => void navigator.clipboard.writeText(head.worktree!)}>
                      复制路径
                    </PxButton>
                  </div>
                </Row>
              )}
              <Row label="开单">
                <p className={body}>{wallClockText(issue.createdAt)}</p>
              </Row>
              {issue.closedAt !== undefined && (
                <Row label="关单">
                  <p className={body}>{wallClockText(issue.closedAt)}</p>
                </Row>
              )}
              <Row label="做过">
                <p className={body}>{s.historyLine}</p>
              </Row>
              <Row label="用时">
                <p className={body}>{s.usedLine(steps, now)}</p>
              </Row>
              <div className="flex flex-wrap gap-2">
                {onThread && (
                  <PxButton size="sm" onClick={onThread}>
                    看工单串
                  </PxButton>
                )}
                {s.inTask && onTask && (
                  <PxButton size="sm" onClick={onTask}>
                    看计划
                  </PxButton>
                )}
              </div>
            </div>
          </Fold>
        </div>
      </div>
    </div>
  );
}

/** The helper on its crop, what it is and which plot and round. */
function Aside({ session, agent }: { session: Session; agent?: Agent }) {
  const { village } = useVillage();
  const { frame } = useFrames();
  const plot = frame ? plotOf(frame.view, session) : { crop: "empty" as const };
  const atlas = village?.atlas;
  const prefix = atlas ? castPrefix(agent?.look, session.agent, (n) => atlas.has(n)) : undefined;
  const [species, outfit] = (prefix ?? "bear-farmer").split("-");
  const crop = atlas?.has(`plot-${plot.crop}`) ? atlas.get(`plot-${plot.crop}`) : undefined;
  const body = prefix && atlas ? atlas.get(`${prefix}-down`) : undefined;
  return (
    <div className="flex w-full shrink-0 flex-col items-center bg-cream-100 p-3 sm:w-52">
      <div className="relative flex h-44 w-44 items-end justify-center">
        {crop && <img src={crop.url} alt="" className="absolute bottom-0 w-44 opacity-90 [image-rendering:pixelated]" />}
        {body && <img src={body.url} alt="" className="relative h-36 [image-rendering:pixelated]" />}
      </div>
      <p className="mt-2 text-[13px]">{cropLabel[plot.crop]}</p>
      <p className={`text-center ${xs}`}>
        {speciesLabel[species ?? ""] ?? species} · {outfitLabel[outfit ?? ""] ?? outfit}
      </p>
      <p className={xs}>
        第 {stationOfSession(session) + 1} 块地 · 第 {Math.round(session.runs)} 轮
      </p>
    </div>
  );
}

/** 聊清楚 → 安排活 → 完成, the one it is at marked. */
function StageRail({ at }: { at: Stage }) {
  const here = stages.indexOf(at);
  return (
    <div className="mb-3 flex border border-cream-300">
      {stages.map((st, i) => (
        <span
          key={st}
          className="flex flex-1 items-center justify-center gap-1 py-1.5 text-[13px]"
          style={{ background: i === here ? tint("#e5a93c", 0.45) : i < here ? tint("#b4cb7c", 0.5) : undefined, color: i === here ? "#2f1f13" : "#7f5b3b" }}
        >
          {stageLabel[st]}
          {i < here && <SpriteIcon name="mark-check" size={12} label={`${stageLabel[st]}做完了`} />}
        </span>
      ))}
    </div>
  );
}

/** The criteria; while it is judged, each can be ticked off as the owner checks it (on this page only). */
function Criteria({ criteria, checking }: { criteria: string[]; checking: boolean }) {
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  return (
    <div className="mt-2 flex flex-col">
      <p className={xs}>{checking ? "照验收标准看，看过一条勾一条" : "验收标准"}</p>
      {criteria.map((c, i) =>
        checking ? (
          <button
            key={i}
            type="button"
            aria-pressed={ticked.has(i)}
            onClick={() => setTicked((t) => (t.has(i) ? new Set([...t].filter((x) => x !== i)) : new Set([...t, i])))}
            className="group flex cursor-pointer items-start gap-2 py-0.5 text-left"
          >
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border-2 border-bark-400 bg-cream-50 group-hover:border-bark-600">
              {ticked.has(i) && <SpriteIcon name="mark-check" size={12} label="看过了" />}
            </span>
            <span className={`${body} ${ticked.has(i) ? "text-bark-500" : ""}`}>{c}</span>
          </button>
        ) : (
          <p key={i} className={body}>
            · {c}
          </p>
        ),
      )}
    </div>
  );
}

function Fold({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-cream-300">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex w-full cursor-pointer items-center gap-1.5 py-2 text-left"
      >
        <SpriteIcon name="button-next" size={12} className={open ? "rotate-90" : ""} />
        <span className="text-[13px] text-bark-800 group-hover:text-bark-900">{label}</span>
      </button>
      {open && <div className="pb-3">{children}</div>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2 flex items-start gap-3">
      <span className="w-[72px] shrink-0 text-[13px] text-bark-500">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** The issue's runs, read again whenever `version` changes. */
function Runs({ issue, version }: { issue: string; version: string }) {
  const runs = useQuery({ queryKey: ["issue-runs", issue, version], queryFn: () => api.issue.runs({ id: issue }) }).data ?? [];
  if (runs.length === 0) return <p className={xs}>还没有干过。</p>;
  const now = Date.now();
  return (
    <FarmSection title="每次干活">
      <p className={xs}>{runs.length} 次</p>
      {[...runs].reverse().map((r) => (
        <Row key={r.id} label={wallClockText(r.startedAt)}>
          <p className={body}>{runText(r, now, tookText)}</p>
        </Row>
      ))}
    </FarmSection>
  );
}
