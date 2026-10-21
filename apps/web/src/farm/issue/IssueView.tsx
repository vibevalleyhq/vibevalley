// A plot's issue, opened by clicking the plot or its helper: the helper standing on its crop at the side; the stages,
// the title and one box that says how it is now, the weeds, the criteria (ticked off while it is judged), one box to
// talk to the helper, judge it or reopen it, and the offers (stop, resolve, go on, harvest, fix, close); folded under
// it the changes, the work log, each run and the details. What it says and offers is src/rules/issueState.ts, the
// server's state read; the workbench draws the same issue as its own page.

import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useQuery } from "@tanstack/solid-query";
import type { Acceptance, Agent, Issue, Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { farm, overlayOf } from "../store";
import { cropLabel, issueOf, plotOf, stationOfSession } from "../world/plots";
import { castPrefix } from "../../rules/cast";
import { issueThreadOf } from "../../rules/chat";
import { changesLine, findingsOf, type IssueOffer, issueState, noStepsText, resumeWords } from "../../rules/issueState";
import { issueTag, runText, type Stage, stageLabel, stageOf, stages, tagLabel } from "../../rules/issues";
import { tookText, wallClockText } from "../../rules/time";
import { aria, useNow } from "../../app/util";
import { useRouter } from "../../app/router";
import { createSessionEvents } from "../../pages/chat/data";
import { WorkLog } from "../../pages/chat/WorkLog";
import { useCore, useFrames } from "../../data/frame";
import { useIssueHistory } from "../../data/issues";
import { ready, useAgents } from "../../data/query";
import { FarmDialog, FarmSection, PxButton, PxTextArea, SpriteIcon, toasts, ToastType } from "../kit";
import { tint } from "../panels/bits";
import { commands, useFarm } from "../state";
import { useVillage } from "../support";

const tones: Record<string, string> = { berry: "#c84a3a", wheat: "#e5a93c", water: "#4f8fbd", leaf: "#74a046", faint: "#c8a46e", muted: "#9b7550" };
const body = "text-[13px] leading-[1.5] text-bark-800";
const xs = "text-[12px] text-bark-600";

const speciesLabel: Record<string, string> = { bear: "熊", rabbit: "兔子", fox: "小狐狸", cat: "猫", owl: "猫头鹰", hedgehog: "刺猬", raccoon: "浣熊" };
const outfitLabel: Record<string, string> = { farmer: "农夫", gardener: "园丁", rain: "雨衣", winter: "冬装" };

/** The plot's issue while the store says so (the inspect layer). */
export function IssueView() {
  const inspect = useFarm((s) => overlayOf(s, "inspect")?.sessionId);
  const core = useCore();
  const session = () => {
    const id = inspect();
    return id ? core()?.sessions.find((s) => s.id === id) : undefined;
  };
  return (
    <Show when={session()}>
      {(s) => (
        <FarmDialog title={`${s().name}的地`} size="lg" onClose={() => farm.select(null)}>
          <PlotDetail session={s()} onDone={() => farm.select(null)} />
        </FarmDialog>
      )}
    </Show>
  );
}

function PlotDetail(props: { session: Session; onDone: () => void }) {
  const core = useCore();
  const router = useRouter();
  const history = useIssueHistory(() => true);
  const id = () => issueOf(props.session);
  const issue = () => core()?.issues?.find((i) => i.id === id());
  const sessions = () => {
    const found = history.rows()?.find((h) => h.issue.id === id())?.sessions ?? [props.session];
    return found.length ? found : [props.session];
  };
  const hasThread = () => issueThreadOf(core()?.chat, id()) !== undefined;
  return (
    <Show when={issue()} fallback={<p class={body}>这块地的工单还没读到。</p>}>
      {(i) => (
        <IssueBody
          issue={i()}
          sessions={sessions()}
          session={props.session}
          onHarvest={(s) => {
            farm.review(s.id);
            props.onDone();
          }}
          onClose={(s) => api.issue.status({ id: issueOf(s), body: { status: "canceled" } }).then(() => props.onDone())}
          onThread={
            hasThread()
              ? () => {
                  const thread = issueThreadOf(core()?.chat, id());
                  if (thread) farm.showChat(thread.id);
                  props.onDone();
                }
              : undefined
          }
          onNavigate={() => router.navigate(`/issues/${encodeURIComponent(id())}`)}
          onTask={
            props.session.graph
              ? () => {
                  farm.openTaskBoard(props.session.graph!.id);
                  props.onDone();
                }
              : undefined
          }
        />
      )}
    </Show>
  );
}

const offerWords: Record<IssueOffer["act"], string> = {
  stop: "叫停这一轮",
  resolve: "让它解决冲突",
  resume: "接着做",
  harvest: "收获",
  cure: "接着修",
  close: "关上",
};

function IssueBody(props: {
  issue: Issue;
  sessions: Session[];
  session: Session;
  onHarvest: (s: Session) => void;
  onClose: (s: Session) => Promise<void>;
  onThread?: () => void;
  onNavigate: () => void;
  onTask?: () => void;
}) {
  const frames = useFrames();
  const agentsQuery = useAgents();
  const now = useNow();
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const tag = () => issueTag(props.issue);
  const s = createMemo(() => issueState(props.issue, props.sessions, tag(), props.session, frames.frame?.graphs ?? []));
  const changes = useQuery(() => ({
    queryKey: ["issues", "changes", props.issue.id],
    queryFn: () => api.issue.changes({ id: props.issue.id }),
    enabled: s().showsChanges,
  }));
  const changed = () => ready(changes, undefined);
  const steps = createSessionEvents(
    () => s().head.id,
    () => true,
  );
  const agent = () => ready(agentsQuery, []).find((a) => a.id === s().head.agent);

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
    const who = s().session;
    const said = text();
    if (!said.trim() || !who) return;
    await act(() => commands.water(who, said));
    setText("");
  };
  const reopen = () => {
    const id = props.issue.id;
    const said = text().trim() || undefined;
    return act(async () => {
      const got = await api.issue.status({ id, body: { status: "todo", text: said } });
      const helper = got.sessions.at(-1);
      if (helper) {
        setText("");
        toasts.add({ type: ToastType.info, title: "工单重开了", description: `${helper} 接着做。` });
      }
    });
  };
  const accept = async (pass: boolean) => {
    const id = props.issue.id;
    if (pass) return act(() => api.issue.accept({ id, body: { pass: true } }));
    const lines = findingsOf(text());
    if (lines.length === 0) return;
    await act(() => api.issue.accept({ id, body: { pass: false, findings: lines } }));
    setText("");
  };
  const setAcceptance = (a: Acceptance) => {
    const id = props.issue.id;
    return act(() => api.issue.update({ id, body: { acceptance: a } }));
  };
  const run = (o: IssueOffer, h: Session): (() => Promise<unknown>) => {
    switch (o.act) {
      case "stop":
        return () => commands.stop(h.id);
      case "resolve":
        return () => commands.resolve(h);
      case "resume":
        return () => commands.water(h, resumeWords);
      case "harvest":
        return async () => props.onHarvest(h);
      case "cure":
        return () => commands.cure(h);
      case "close":
        return () => props.onClose(h);
    }
  };
  const actions = () => (
    <>
      <Show when={s().session}>
        {(h) => (
          <For each={s().offers}>
            {(o) => (
              <PxButton tone={o.act === "close" ? "danger" : o.lead ? "primary" : "plain"} disabled={busy()} onClick={() => void act(run(o, h()))}>
                {offerWords[o.act]}
              </PxButton>
            )}
          </For>
        )}
      </Show>
      <PxButton icon="button-open" onClick={() => props.onNavigate()}>
        在看板上看
      </PxButton>
    </>
  );

  return (
    <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
      <Aside session={s().head} agent={agent()} />
      <div class="flex min-w-0 flex-1 flex-col">
        <StageRail at={stageOf(props.issue.status)} />
        <div class="flex items-start gap-2">
          <h3 class="min-w-0 flex-1 text-[16px]">{s().title}</h3>
          <span class={xs}>{tagLabel[tag()]}</span>
        </div>
        <Show when={s().project}>
          <p class={xs}>{s().project}</p>
        </Show>
        <div class="mt-3 p-3" style={{ background: tint(tones[s().status.tone] ?? "#c8a46e", 0.3) }}>
          <p class="text-[14px]">{s().status.head}</p>
          <Show when={s().status.line}>
            <p class={["mt-1 line-clamp-4", body]}>{s().status.line}</p>
          </Show>
          <For each={s().status.list}>{(a) => <p class={body}>· {a}</p>}</For>
          <Show when={s().inTask}>
            <p class={["mt-1", xs]}>{s().taskText}</p>
          </Show>
        </div>
        <Show when={s().weeds.length > 0}>
          <div class="mt-2">
            <For each={s().weeds}>{(f) => <p class={[body, "text-berry"]}>草 · {f.text}</p>}</For>
          </div>
        </Show>
        <Show when={(props.issue.criteria ?? []).length > 0}>
          <Criteria criteria={props.issue.criteria!} checking={s().judging} />
        </Show>
        <Show when={s().hasBox} fallback={<div class="mt-3 flex flex-wrap gap-2">{actions()}</div>}>
          <div class="mt-3 flex flex-col gap-2">
            <PxTextArea value={text()} onChange={setText} rows={s().judging ? 3 : 2} placeholder={s().placeholder} label={s().boxLabel} disabled={busy()} />
            <div class="flex flex-wrap gap-2">
              <Show when={s().talking}>
                <PxButton disabled={busy() || !text().trim()} onClick={() => void tell()}>
                  带话
                </PxButton>
              </Show>
              <Show when={s().judging}>
                <PxButton tone="primary" disabled={busy()} onClick={() => void accept(true)}>
                  验收通过
                </PxButton>
                <PxButton tone="danger" disabled={busy() || !text().trim()} onClick={() => void accept(false)}>
                  没过，照上面修
                </PxButton>
              </Show>
              <Show when={s().reopening}>
                <PxButton tone="primary" disabled={busy()} onClick={() => void reopen()}>
                  重开
                </PxButton>
              </Show>
              {actions()}
            </div>
          </div>
        </Show>
        <div class="mt-4">
          <Show when={s().showsChanges}>
            <Fold label={changed() ? `改动（${changed()!.files.length} 个文件）` : "改动"}>
              <Show when={changed()} fallback={<p class={body}>{changes.isPending ? "在读……" : "读不到改动。"}</p>}>
                {(c) => (
                  <div class="flex flex-col">
                    <p class={body}>{changesLine(c())}</p>
                    <Show when={c().conflicts.length > 0}>
                      <p class={[body, "text-berry"]}>
                        合进 {c().base} 会冲突：{c().conflicts.join("、")}
                      </p>
                    </Show>
                    <div class="mt-1.5">
                      <For each={c().files.slice(0, 12)}>
                        {(f) => (
                          <p class="truncate font-mono text-[11px] text-bark-800">
                            {f.path} +{Math.round(f.added)} -{Math.round(f.removed)}
                          </p>
                        )}
                      </For>
                      <Show when={c().files.length > 12}>
                        <p class={xs}>还有 {c().files.length - 12} 个文件</p>
                      </Show>
                    </div>
                  </div>
                )}
              </Show>
            </Fold>
          </Show>
          <Fold label="干活过程">
            <Show when={steps().length > 0} fallback={<p class={xs}>{noStepsText(s().head)}</p>}>
              <WorkLog steps={steps()} now={now()} working={tag() === "working"} />
            </Show>
          </Fold>
          <Fold label="每次干活">
            <Runs issue={props.issue.id} version={`${props.issue.sessions.length}:${s().head.runs}:${s().head.phase._tag}`} />
          </Fold>
          <Fold label="详情">
            <div class="flex flex-col">
              <Show when={s().description && s().description !== s().title}>
                <Row label="要做的">
                  <p class="whitespace-pre-wrap text-[13px] text-bark-800">{s().description}</p>
                </Row>
              </Show>
              <Row label="谁在做">
                <p class={body}>{s().whoLine}</p>
              </Row>
              <Show when={s().crewLine}>
                <Row label="地上的人">
                  <p class={body}>{s().crewLine}</p>
                </Row>
              </Show>
              <Show when={s().acceptanceEditable}>
                <Row label="验收">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <For
                      each={
                        [
                          ["glance", "看一眼就收"],
                          ["required", "必须过验收"],
                        ] as const
                      }
                    >
                      {([a, label]) => (
                        <PxButton
                          size="sm"
                          tone={props.issue.acceptance === a ? "primary" : "plain"}
                          disabled={busy() || props.issue.acceptance === a || !s().open}
                          onClick={() => void setAcceptance(a)}
                        >
                          {label}
                        </PxButton>
                      )}
                    </For>
                    <Show when={props.issue.acceptedAt !== undefined}>
                      <span class="text-[12px] text-leaf-700">已验收 {wallClockText(props.issue.acceptedAt!)}</span>
                    </Show>
                  </div>
                </Row>
              </Show>
              <Show when={s().pulled.length > 0}>
                <Row label="拔了的草">
                  <For each={s().pulled}>{(f) => <p class={[body, "text-bark-400 line-through"]}>已拔 · {f.text}</p>}</For>
                </Row>
              </Show>
              <Show when={agent()?.model}>
                <Row label="模型">
                  <p class={body}>{agent()!.model}</p>
                </Row>
              </Show>
              <Show when={s().head.branch}>
                <Row label="分支">
                  <p class="font-mono text-[12.5px] text-bark-800">{s().head.branch}</p>
                </Row>
              </Show>
              <Show when={s().head.worktree}>
                {(tree) => (
                  <Row label="worktree">
                    <div class="flex items-center gap-2">
                      <span class="min-w-0 flex-1 font-mono text-[12.5px] break-all select-text">{tree()}</span>
                      <PxButton size="sm" onClick={() => void navigator.clipboard.writeText(tree())}>
                        复制路径
                      </PxButton>
                    </div>
                  </Row>
                )}
              </Show>
              <Row label="开单">
                <p class={body}>{wallClockText(props.issue.createdAt)}</p>
              </Row>
              <Show when={props.issue.closedAt !== undefined}>
                <Row label="关单">
                  <p class={body}>{wallClockText(props.issue.closedAt!)}</p>
                </Row>
              </Show>
              <Row label="做过">
                <p class={body}>{s().historyLine}</p>
              </Row>
              <Row label="用时">
                <p class={body}>{s().usedLine(steps(), now())}</p>
              </Row>
              <div class="flex flex-wrap gap-2">
                <Show when={props.onThread}>
                  <PxButton size="sm" onClick={() => props.onThread?.()}>
                    看工单串
                  </PxButton>
                </Show>
                <Show when={s().inTask && props.onTask}>
                  <PxButton size="sm" onClick={() => props.onTask?.()}>
                    看计划
                  </PxButton>
                </Show>
              </div>
            </div>
          </Fold>
        </div>
      </div>
    </div>
  );
}

/** The helper on its crop, what it is and which plot and round. */
function Aside(props: { session: Session; agent?: Agent }) {
  const loaded = useVillage();
  const frames = useFrames();
  const plot = () => (frames.frame ? plotOf(frames.frame.view, props.session) : { crop: "empty" as const });
  const atlas = () => loaded().village?.atlas;
  const prefix = () => {
    const a = atlas();
    return a ? castPrefix(props.agent?.look, props.session.agent, (n) => a.has(n)) : undefined;
  };
  const kind = () => (prefix() ?? "bear-farmer").split("-");
  const crop = () => {
    const a = atlas();
    return a?.has(`plot-${plot().crop}`) ? a.get(`plot-${plot().crop}`) : undefined;
  };
  const figure = () => {
    const a = atlas();
    const p = prefix();
    return p && a ? a.get(`${p}-down`) : undefined;
  };
  return (
    <div class="flex w-full shrink-0 flex-col items-center bg-cream-100 p-3 sm:w-52">
      <div class="relative flex h-44 w-44 items-end justify-center">
        <Show when={crop()}>{(c) => <img src={c().url} alt="" class="absolute bottom-0 w-44 opacity-90 [image-rendering:pixelated]" />}</Show>
        <Show when={figure()}>{(f) => <img src={f().url} alt="" class="relative h-36 [image-rendering:pixelated]" />}</Show>
      </div>
      <p class="mt-2 text-[13px]">{cropLabel[plot().crop]}</p>
      <p class={["text-center", xs]}>
        {speciesLabel[kind()[0] ?? ""] ?? kind()[0]} · {outfitLabel[kind()[1] ?? ""] ?? kind()[1]}
      </p>
      <p class={xs}>
        第 {stationOfSession(props.session) + 1} 块地 · 第 {Math.round(props.session.runs)} 轮
      </p>
    </div>
  );
}

/** 聊清楚 → 安排活 → 完成, the one it is at marked. */
function StageRail(props: { at: Stage }) {
  const here = () => stages.indexOf(props.at);
  return (
    <div class="mb-3 flex border border-cream-300">
      <For each={stages}>
        {(st, i) => (
          <span
            class="flex flex-1 items-center justify-center gap-1 py-1.5 text-[13px]"
            style={{
              background: i() === here() ? tint("#e5a93c", 0.45) : i() < here() ? tint("#b4cb7c", 0.5) : undefined,
              color: i() === here() ? "#2f1f13" : "#7f5b3b",
            }}
          >
            {stageLabel[st]}
            <Show when={i() < here()}>
              <SpriteIcon name="mark-check" size={12} label={`${stageLabel[st]}做完了`} />
            </Show>
          </span>
        )}
      </For>
    </div>
  );
}

/** The criteria; while it is judged, each can be ticked off as the owner checks it (on this page only). */
function Criteria(props: { criteria: string[]; checking: boolean }) {
  const [ticked, setTicked] = createSignal<ReadonlySet<number>>(new Set());
  return (
    <div class="mt-2 flex flex-col">
      <p class={xs}>{props.checking ? "照验收标准看，看过一条勾一条" : "验收标准"}</p>
      <For each={props.criteria}>
        {(c, i) => (
          <Show when={props.checking} fallback={<p class={body}>· {c}</p>}>
            <button
              type="button"
              aria-pressed={aria(ticked().has(i()))}
              onClick={() => setTicked((t) => (t.has(i()) ? new Set([...t].filter((x) => x !== i())) : new Set([...t, i()])))}
              class="group flex cursor-pointer items-start gap-2 py-0.5 text-left"
            >
              <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border-2 border-bark-400 bg-cream-50 group-hover:border-bark-600">
                <Show when={ticked().has(i())}>
                  <SpriteIcon name="mark-check" size={12} label="看过了" />
                </Show>
              </span>
              <span class={[body, { "text-bark-500": ticked().has(i()) }]}>{c}</span>
            </button>
          </Show>
        )}
      </For>
    </div>
  );
}

function Fold(props: { label: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="border-t border-cream-300">
      <button
        type="button"
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        class="group flex w-full cursor-pointer items-center gap-1.5 py-2 text-left"
      >
        <SpriteIcon name="button-next" size={12} class={open() ? "rotate-90" : ""} />
        <span class="text-[13px] text-bark-800 group-hover:text-bark-900">{props.label}</span>
      </button>
      <Show when={open()}>
        <div class="pb-3">{props.children}</div>
      </Show>
    </div>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div class="mb-2 flex items-start gap-3">
      <span class="w-[72px] shrink-0 text-[13px] text-bark-500">{props.label}</span>
      <div class="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

/** The issue's runs, read again whenever `version` changes. */
function Runs(props: { issue: string; version: string }) {
  const runsQuery = useQuery(() => ({ queryKey: ["issue-runs", props.issue, props.version], queryFn: () => api.issue.runs({ id: props.issue }) }));
  const runs = () => ready(runsQuery, []);
  const now = useNow();
  return (
    <Show when={runs().length > 0} fallback={<p class={xs}>还没有干过。</p>}>
      <FarmSection title="每次干活">
        <p class={xs}>{runs().length} 次</p>
        <For each={[...runs()].reverse()} keyed={(r) => r.id}>
          {(r) => (
            <Row label={wallClockText(r().startedAt)}>
              <p class={body}>{runText(r(), now(), tookText)}</p>
            </Row>
          )}
        </For>
      </FarmSection>
    </Show>
  );
}
