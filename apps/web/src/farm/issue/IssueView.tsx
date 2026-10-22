// A plot's issue, opened by clicking the plot or its helper: the helper attention on its crop at the side; then, as the
// workbench's page has it, what it is and where it stands, the one thing asked of the owner (only when there is one),
// how far it is against its criteria, and folded under it what it made, how it got here, each step and the details.
// Where it stands and what may be done is the server's Issue.attention, worded by src/rules/issueState.ts.

import { createMemo, createSignal, Errored, For, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

import type { Review, Agent, Issue, IssueAct, Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { createIssueActs } from "../../data/issueActs";
import { farm, overlayOf } from "../store";
import { cropLabel, issueOf, plotOf, stationOfSession } from "../world/plots";
import { castPrefix } from "../../rules/cast";
import { issueThreadOf } from "../../rules/chat";
import { changesLine, type CriterionRow, issueState, nothingChanged, noStepsText } from "../../rules/issueState";
import { runText } from "../../rules/issues";
import { tookText, wallClockText } from "../../rules/time";
import { aria, useNow } from "../../app/util";
import { useRouter } from "../../app/router";
import { createSessionEvents } from "../../data/sessions";
import { WorkLog } from "../../pages/chat/WorkLog";
import { useCore, useFrames } from "../../data/frame";
import { useIssueChanges, useIssueHistory, useIssueRuns, useIssueTimeline } from "../../data/issues";
import { ready } from "../../data/query";
import { FarmDialog, FarmSection, PxButton, PxTextArea, SpriteIcon, toasts, ToastType } from "../kit";
import { tint } from "../panels/bits";
import { commands, useFarm } from "../state";
import { useVillage } from "../support";
import { useAgent } from "../../data/agents";

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
          onClose={(s) => api.issue.act({ id: issueOf(s), body: { act: "close" } }).then(() => props.onDone())}
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
  const now = useNow();
  // The farm carries out an answer, a word to the helper and the fixes with its own commands (and their effects).
  const water = (words: string) => commands.water(props.session, words);
  const acts = createIssueActs(() => props.issue, {
    run: async (f) => {
      try {
        await f();
        return true;
      } catch (e) {
        toasts.add({ type: ToastType.warn, title: "没办成", description: reasonOf(e) });
        return false;
      }
    },
    own: {
      tell: water,
      resolve: () => commands.resolve(props.session),
      cure: () => commands.cure(props.session),
      stop: () => commands.stop(props.session),
    },
    harvest: () => props.onHarvest(props.session),
    close: () => props.onClose(props.session),
    told: (title, description) => toasts.add({ type: ToastType.info, title, description }),
  });
  const { busy, text, setText, box, go } = acts;
  const s = createMemo(() => issueState(props.issue, props.sessions, props.session, frames.frame?.graphs ?? []));
  const changes = useIssueChanges(
    () => props.issue.id,
    () => s().showsChanges,
  );
  const changed = () => ready(changes, undefined);
  const timelineQuery = useIssueTimeline(
    () => props.issue,
    () => s().head.runs,
  );
  const timeline = () => ready(timelineQuery, undefined);
  const steps = createSessionEvents(
    () => s().head.id,
    () => true,
  );
  const agent = useAgent(() => s().head.agent);
  const state = () => s().attention.state;

  const setReview = (a: Review) => {
    const id = props.issue.id;
    return acts.act(() => api.issue.update({ id, body: { review: a } }));
  }; /** lead is read as it renders: the lead changes as the issue moves on. */
  const button = (a: IssueAct, lead: () => boolean) => (
    <PxButton tone={lead() ? "primary" : a === "close" || acts.rejecting(a) ? "danger" : "plain"} disabled={acts.disabled(a)} onClick={() => go(a)}>
      {acts.label(a)}
    </PxButton>
  );
  /** The block asks for the lead and its own others; the rest go in the row at the bottom. */
  const blockActs = () => (s().ask ? s().others.filter((a) => a !== "close" && a !== "stop") : []);
  const rowActs = () => (s().ask ? s().attention.acts.filter((a) => a === "close" || a === "stop") : s().attention.acts);
  const boxShown = () => state() === "asking" || state() === "closed" || box() !== undefined;

  return (
    <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
      <Aside session={s().head} agent={agent()} />
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-baseline gap-2">
          <span class={xs}>#{props.issue.number}</span>
          <h3 class="min-w-0 flex-1 truncate text-[16px]" title={s().title}>
            {s().title}
          </h3>
          <Show when={s().project}>
            <span class={xs}>{s().project}</span>
          </Show>
        </div>
        <p class="mt-1 text-[13px]" style={{ color: s().attention.state === "stuck" ? tones.berry : "#5a3d26" }} aria-label="现在怎样">
          {s().statusLine(now(), timeline()?.spent?.cny)}
        </p>

        <Show when={s().ask}>
          {(ask) => (
            <div class="mt-3 p-3" style={{ background: tint(tones[ask().tone] ?? "#c8a46e", 0.3) }} aria-label="要你做的" role="region">
              <p class="text-[14px]">{ask().head}</p>
              <Show when={ask().line}>
                <p class={["mt-1 line-clamp-4 whitespace-pre-wrap", body]}>{ask().line}</p>
              </Show>
              <Show when={state() === "asking"}>
                <For each={props.issue.questions}>
                  {(q) => (
                    <div class="mt-2">
                      <p class={body}>{q.question}</p>
                      <Show when={q.options?.length}>
                        <div class="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label={`回答：${q.question}`}>
                          <For each={q.options}>
                            {(o) => (
                              <PxButton size="sm" disabled={busy()} onClick={() => void acts.send("answer", o).then((ok) => ok && acts.setText(""))}>
                                {o}
                              </PxButton>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          )}
        </Show>
        <Show when={boxShown()}>
          <div class="mt-2">
            <PxTextArea
              value={text()}
              onChange={setText}
              rows={box() === "reject" ? 3 : 2}
              placeholder={
                box() === "reject"
                  ? "哪里没过，一行一条"
                  : state() === "asking"
                    ? "自己说……"
                    : state() === "closed"
                      ? "这次要它做什么（不填就是接着做完）"
                      : props.session.phase._tag === "working"
                        ? "干着活也能收到这句话"
                        : "说一句，它接着做一轮"
              }
              label={box() === "reject" ? "哪里没过" : state() === "asking" ? "回答" : state() === "closed" ? "重开这张工单" : `给${props.session.name}带句话`}
              disabled={busy()}
            />
          </div>
        </Show>
        <div class="mt-3 flex flex-wrap gap-2">
          <Show when={s().ask && s().lead} keyed>
            {(lead) => button(lead, () => true)}
          </Show>
          <For each={blockActs()}>{(a) => button(a, () => false)}</For>
          <For each={rowActs()}>{(a) => button(a, () => !s().ask && a === s().lead)}</For>
          <PxButton icon="button-open" onClick={() => props.onNavigate()}>
            在看板上看
          </PxButton>
        </div>

        <FarmSection title={s().criteria.length > 0 ? `做到哪了 · ${s().met} / ${s().criteria.length} 条做到了` : "做到哪了"}>
          <Show when={s().doing}>
            <p class={[body, "text-[#4f8fbd]"]}>{s().doing}</p>
          </Show>
          <Show when={s().inTask}>
            <p class={xs}>{s().taskText}</p>
          </Show>
          <Show when={s().criteria.length > 0} fallback={<p class={xs}>这张工单没写做完的标准：交回来时看改动判断。</p>}>
            <Criteria rows={s().criteria} checking={state() === "reviewing" && props.issue.reviewedAt === undefined} />
          </Show>
          <Show when={s().weeds.length > 0}>
            <div class="mt-1.5">
              <For each={s().weeds}>{(f) => <p class={[body, "text-berry"]}>上次打回 · {f.text}</p>}</For>
            </div>
          </Show>
        </FarmSection>

        <div class="mt-4">
          <Show when={s().showsChanges}>
            <Fold
              label={changed() ? (nothingChanged(changed()!) ? "做出了什么：还没有改动" : `做出了什么（${changed()!.files.length} 个文件）`) : "做出了什么"}
            >
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
          <Fold label="怎么走到这一步">
            <Show when={timeline()} fallback={<p class={xs}>{timelineQuery.isPending ? "在读……" : "读不到。"}</p>}>
              {(t) => (
                <For each={t().milestones}>
                  {(m) => (
                    <Row label={wallClockText(m.at)}>
                      <p class={[body, { "text-berry": m.kind === "failed" || m.kind === "rejected" }]}>
                        {m.who ? `${m.who} · ` : ""}
                        {m.text}
                      </p>
                    </Row>
                  )}
                </For>
              )}
            </Show>
          </Fold>
          <Fold label="帮工的每一步">
            <Show when={steps().length > 0} fallback={<p class={xs}>{noStepsText(s().head)}</p>}>
              <WorkLog steps={steps()} now={now()} working={state() === "working"} />
            </Show>
          </Fold>
          <Fold label="每次干活">
            <Runs issue={props.issue.id} version={`${props.issue.sessions.length}:${s().head.runs}:${s().head.phase._tag}`} />
          </Fold>
          <Fold label="详情">
            <div class="flex flex-col">
              <Show when={s().description}>
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
              <Show when={!s().inTask}>
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
                          tone={props.issue.review === a ? "primary" : "plain"}
                          disabled={busy() || props.issue.review === a || !s().open}
                          onClick={() => void setReview(a)}
                        >
                          {label}
                        </PxButton>
                      )}
                    </For>
                    <Show when={props.issue.reviewedAt !== undefined}>
                      <span class="text-[12px] text-leaf-700">已验收 {wallClockText(props.issue.reviewedAt!)}</span>
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

const resultMark: Record<NonNullable<CriterionRow["result"]>, { icon: string; label: string }> = {
  met: { icon: "mark-check", label: "它说做到了" },
  unmet: { icon: "mark-cross", label: "它说没做到" },
  unsure: { icon: "mark-warn", label: "它说不确定" },
};

/** The criteria with the helper's word on each; while it is judged, each can be ticked off as the owner checks it (on
 * this page only). */
function Criteria(props: { rows: CriterionRow[]; checking: boolean }) {
  const [ticked, setTicked] = createSignal<ReadonlySet<number>>(new Set());
  const mark = (r: CriterionRow) => (r.result ? <SpriteIcon name={resultMark[r.result].icon} size={14} label={resultMark[r.result].label} /> : undefined);
  return (
    <div class="flex flex-col">
      <For each={props.rows} keyed={(r) => r.text}>
        {(r, i) => (
          <Show
            when={props.checking}
            fallback={
              <div class="flex items-start gap-2 py-0.5">
                <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  {mark(r()) ?? <span class="h-2.5 w-2.5 border-2 border-bark-300" />}
                </span>
                <span class="min-w-0 flex-1">
                  <span class={body}>{r().text}</span>
                  <Show when={r().proof}>
                    <span class={["block", xs]}>{r().proof}</span>
                  </Show>
                </span>
              </div>
            }
          >
            <button
              type="button"
              aria-pressed={aria(ticked().has(i()))}
              aria-label={r().text}
              onClick={() => setTicked((t) => (t.has(i()) ? new Set([...t].filter((x) => x !== i())) : new Set([...t, i()])))}
              class="group flex cursor-pointer items-start gap-2 py-0.5 text-left"
            >
              <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border-2 border-bark-400 bg-cream-50 group-hover:border-bark-600">
                <Show when={ticked().has(i())}>
                  <SpriteIcon name="mark-check" size={12} label="看过了" />
                </Show>
              </span>
              <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{mark(r())}</span>
              <span class="min-w-0 flex-1">
                <span class={[body, { "text-bark-500": ticked().has(i()) }]}>{r().text}</span>
                <Show when={r().proof}>
                  <span class={["block", xs]}>{r().proof}</span>
                </Show>
              </span>
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
      {/* Mounted with the dialog and only hidden while folded: content first mounted by the click reads queries in
          flight, and Solid holds that click's whole update until they land, so the fold would not open. */}
      <div class="pb-3" hidden={!open()}>
        <Errored fallback={<p class="text-[12px] text-bark-500">读不到。</p>}>
          <Loading fallback={<p class="text-[12px] text-bark-500">在读……</p>}>{props.children}</Loading>
        </Errored>
      </div>
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
  const runsQuery = useIssueRuns(
    () => props.issue,
    () => props.version,
  );
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
