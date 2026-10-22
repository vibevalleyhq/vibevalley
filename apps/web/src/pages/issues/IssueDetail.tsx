import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";

import {
  type Deliverable,
  DeliverableValues,
  type Review,
  type Question,
  type Issue,
  type IssueAct,
  type IssueAnswer,
  type Milestone,
  type Session,
  type SessionEvent,
} from "@vibevalley/protocol";
import { api } from "../../data/api";
import { createIssueActs } from "../../data/issueActs";
import type { Tone } from "../../rules/cards";
import { issueTag, priorityLabel, runText, tagOpen, tagText } from "../../rules/issues";
import { changesLine, type CriterionRow, issueState, noStepsText, attentionTone } from "../../rules/issueState";
import { actLabel, closedText, deliverableLabel } from "@vibevalley/protocol/rules";
import { tookText, wallClockText } from "../../rules/time";
import { toast } from "../../ui/toasts";
import { ready } from "../../data/query";
import { useNow } from "../../app/util";
import { Button } from "../../ui/Button";
import { TextArea } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { ChangesBody, ChangesHead } from "./CloseDialog";
import { run, useGraphs } from "./hooks";
import { Fold, IssueSheet, More, Note, Pick, Property, SheetLabel } from "./Sheet";
import { useIssueChanges, useIssueRuns, useIssueTimeline } from "../../data/issues";
import { useAgent } from "../../data/agents";
import { createSessionEvents } from "../../data/sessions";

function Dot(props: { tone: Tone }) {
  return <span class="size-2 shrink-0 rounded-full" style={{ background: `var(--color-${props.tone})` }} />;
}

/** The workbench's issue page, answering the owner top to bottom: what it is, where it stands, the one thing asked of
 * the owner (only when there is one), how far it is against its criteria, what it made, and how it got here; the
 * side holds the facts. `onClose` opens the close dialog (`review`: straight on its changes). */
export function IssueDetail(props: {
  issue: Issue;
  sessions: Session[];
  session?: Session;
  onClose: (session: Session, review: boolean) => void;
  onTask?: () => void;
}) {
  const graphs = useGraphs();
  const now = useNow();
  const s = createMemo(() => issueState(props.issue, props.sessions, props.session, graphs()));
  const head = () => s().head;
  // The box under the block holds an answer, the findings of 打回, a word to the helper, or what a reopen asks for.
  const acts = createIssueActs(() => props.issue, {
    run: async (f) => (await run(async () => (await f(), true))) === true,
    complete: () => props.onClose(props.session ?? head(), true),
    close: () => props.onClose(props.session ?? head(), false),
    told: (title, description) => toast(`${title}：${description}`),
  });
  const { busy, text, setText, box, setBox, go, act } = acts;
  const doAct = acts.send;
  const sayAct = acts.say;
  const agent = useAgent(() => head().agent);
  const steps = createSessionEvents(
    () => head().id,
    () => true,
  );
  const changesQuery = useIssueChanges(
    () => props.issue.id,
    () => s().showsChanges,
  );
  const changes = () => ready(changesQuery, undefined);
  const timelineQuery = useIssueTimeline(
    () => props.issue,
    () => head().runs,
  );
  const timeline = () => ready(timelineQuery, undefined);

  /** lead is read as it renders: the lead changes as the issue moves on. */
  const button = (a: IssueAct, lead: () => boolean) => (
    <Button tone={lead() ? "primary" : acts.rejecting(a) ? "danger" : "plain"} disabled={acts.disabled(a)} onClick={() => go(a)}>
      {acts.label(a)}
    </Button>
  );

  const parent = () => graphs().find((g) => g.id === props.issue.parent);
  const tone = () => attentionTone[s().attention.state];
  const heading = (
    <div class="pr-10">
      <Show when={s().inTask ? props.onTask : undefined}>
        {(onTask) => (
          <button type="button" onClick={() => onTask()()} class="mb-1.5 cursor-pointer text-xs text-water hover:underline">
            ‹ {parent()?.title ? `计划「${parent()!.title}」的一步` : "回到计划"}
          </button>
        )}
      </Show>
      <div class="@container flex flex-wrap items-baseline gap-x-2">
        <span class="shrink-0 text-sm text-muted">#{props.issue.number}</span>
        <h1 class="line-clamp-2 min-w-0 flex-1 text-lg font-semibold" title={s().title}>
          {s().title}
        </h1>
        <span class="shrink-0 text-xs text-muted @max-[560px]:basis-full">
          {[s().project, priorityLabel[props.issue.priority]].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div class="mt-1.5 flex items-center gap-2 text-sm" aria-label="现在怎样">
        <Dot tone={tone()} />
        <span class={tone() === "berry" ? "text-berry" : "text-ink/80"}>{s().statusLine(now(), timeline()?.spent?.cny)}</span>
      </div>
    </div>
  );

  const main = (
    <>
      <Show when={s().ask}>
        {(ask) => (
          <section aria-label="要你做的" class="mb-5">
            <SheetLabel>要你做的</SheetLabel>
            <Note tone={ask().tone}>
              <div class="font-semibold">{ask().head}</div>
              <Show when={ask().line}>
                <div class="mt-1 line-clamp-4 whitespace-pre-wrap">{ask().line}</div>
              </Show>
              <Show when={s().attention.state === "asking"}>
                <For each={props.issue.questions}>
                  {(a) => <Question ask={a} busy={busy()} onPick={(o) => void doAct("answer", o).then((ok) => ok && setText(""))} />}
                </For>
              </Show>
            </Note>
            <Show when={s().attention.state === "asking" || s().attention.state === "canceled" || box()}>
              <TextArea
                class="mt-2.5"
                rows={box() === "reject" ? 3 : 2}
                value={text()}
                disabled={busy()}
                onInput={(e) => setText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && box() !== "reject" && s().attention.state !== "canceled") {
                    e.preventDefault();
                    sayAct(box() === "tell" ? "tell" : "answer");
                  }
                }}
                placeholder={
                  box() === "reject"
                    ? "哪里没过，一行一条"
                    : s().attention.state === "asking"
                      ? "自己说……"
                      : s().attention.state === "canceled"
                        ? "这次要它做什么（不填就是接着做完）"
                        : `给${head().name}带句话`
                }
                aria-label={
                  box() === "reject"
                    ? "哪里没过"
                    : s().attention.state === "asking"
                      ? "回答"
                      : s().attention.state === "canceled"
                        ? "重开这张工单"
                        : `给${head().name}带句话`
                }
              />
            </Show>
            <div class="mt-2.5 flex flex-wrap gap-2">
              <Show when={s().lead} keyed>
                {(lead) => button(lead, () => true)}
              </Show>
              <For each={s().others.filter((a) => a !== "close" && a !== "stop")}>{(a) => button(a, () => false)}</For>
            </div>
          </section>
        )}
      </Show>
      <Show when={!s().ask && box() === "tell"}>
        <section aria-label="带话" class="mb-5">
          <TextArea
            rows={2}
            value={text()}
            disabled={busy()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                sayAct("tell");
              }
            }}
            placeholder={head().phase._tag === "working" ? "干着活也能收到这句话" : "说一句，它接着做一轮"}
            aria-label={`给${head().name}带句话`}
            autofocus
          />
          <div class="mt-2 flex gap-2">
            {button("tell", () => true)}
            <Button disabled={busy()} onClick={() => setBox(undefined)}>
              算了
            </Button>
          </div>
        </section>
      </Show>

      <section aria-label="做到哪了">
        <SheetLabel>
          做到哪了
          <Show when={s().criteria.length > 0}>
            <span class="ml-2 font-normal">
              {s().met} / {s().criteria.length} 条做到了
            </span>
          </Show>
        </SheetLabel>
        <Show when={s().doing}>
          <div class="mb-1.5 text-sm text-water">{s().doing}</div>
        </Show>
        <Show when={s().inTask}>
          <div class="mb-1.5 text-xs text-muted">{s().taskText}</div>
        </Show>
        <Show
          when={s().criteria.length > 0}
          fallback={<p class="text-sm text-muted">这张工单没写做完的标准：交回来时看{props.issue.deliver === "answer" ? "结论" : "改动"}判断。</p>}
        >
          <Criteria rows={s().criteria} checking={s().attention.state === "reviewing" && props.issue.reviewedAt === undefined} />
        </Show>
        <Show when={s().weeds.length > 0}>
          <div class="mt-2">
            <div class="text-xs text-muted">上次打回的</div>
            <For each={s().weeds}>{(f) => <div class="text-sm text-berry">· {f.text}</div>}</For>
          </div>
        </Show>
      </section>

      <section aria-label="做出了什么">
        <SheetLabel>做出了什么</SheetLabel>
        <Switch fallback={<p class="text-sm text-muted">{s().attention.state === "done" ? closedText(props.issue) + "。" : "没有可看的改动。"}</p>}>
          <Match when={props.issue.deliver === "answer"}>
            <Show when={props.issue.answer} fallback={<p class="text-sm text-muted">还没有结论。</p>}>
              {(a) => <AnswerView answer={a()} />}
            </Show>
          </Match>
          <Match when={s().showsChanges && changes()}>
            {(c) => (
              <Show
                when={c().commits.length > 0 || c().uncommitted.length > 0 || c().files.length > 0}
                fallback={<p class="text-sm text-muted">还没有改动。</p>}
              >
                <div class="flex flex-col gap-2">
                  <div class="text-sm">{changesLine(c())}</div>
                  <Show when={c().conflicts.length > 0}>
                    <div class="text-sm text-berry">
                      合进 {c().base} 会冲突：{c().conflicts.join("、")}
                    </div>
                  </Show>
                  <Fold label="改了哪些文件" summary={`${c().files.length} 个`}>
                    <ChangesHead changes={c()} />
                    <ChangesBody changes={c()} />
                  </Fold>
                </div>
              </Show>
            )}
          </Match>
          <Match when={s().showsChanges}>
            <p class="text-sm text-muted">{changesQuery.isPending ? "在读……" : "读不到改动。"}</p>
          </Match>
        </Switch>
        <Show when={props.issue.pullRequest}>
          {(pr) => (
            <a href={pr().url} target="_blank" rel="noreferrer" class="mt-1 block text-sm text-water hover:underline">
              PR #{pr().number}（{pr().state}）
            </a>
          )}
        </Show>
      </section>

      <section aria-label="怎么走到这一步">
        <SheetLabel>怎么走到这一步</SheetLabel>
        <Show when={timeline()} fallback={<p class="text-xs text-faint">{timelineQuery.isPending ? "在读……" : "读不到。"}</p>}>
          {(t) => <Story milestones={t().milestones} />}
        </Show>
        <div class="mt-3 border-t border-line">
          <Show when={s().description}>
            <Fold label="要做的（完整说明）">
              <Markdown class="text-sm text-ink/90" text={s().description} />
            </Fold>
          </Show>
          <Fold label="帮工的每一步" summary={steps().length ? stepsLine(steps()) : undefined}>
            <Show when={steps().length ? steps() : undefined} fallback={<p class="text-xs text-faint">{noStepsText(head())}</p>}>
              {(st) => <WorkLog steps={st()} />}
            </Show>
          </Fold>
          <Fold label="每次干活" summary={s().historyLine}>
            <Runs issue={props.issue.id} version={`${props.issue.attention.state}:${props.session?.runs}:${props.session?.phase._tag}`} />
          </Fold>
        </div>
      </section>
    </>
  );

  // The acts the block above does not offer: a word, a stop, a close.
  const sideActs = () => (s().ask ? s().attention.acts.filter((a) => a === "close" || a === "stop") : s().attention.acts);
  const side = (
    <>
      <Show when={sideActs().length > 0}>
        <div class="mb-3 flex flex-col gap-2">
          <For each={sideActs()}>{(a) => button(a, () => !s().ask && a === s().lead)}</For>
        </div>
      </Show>
      <SheetLabel>时间</SheetLabel>
      <Property label="开单">{wallClockText(props.issue.createdAt)}</Property>
      <Property label="开工">{wallClockText(props.sessions[0]!.hiredAt)}</Property>
      <Show when={s().ask && s().attention.since}>{(at) => <Property label="在等你">{wallClockText(at())} 起</Property>}</Show>
      <Show when={props.issue.reviewedAt}>
        {(at) => (
          <Property label="验收过">
            <span class="text-accent">{wallClockText(at())}</span>
          </Property>
        )}
      </Show>
      <Show when={props.issue.closedAt}>{(at) => <Property label="关单">{wallClockText(at())}</Property>}</Show>
      <SheetLabel>谁在做</SheetLabel>
      <Property label="帮工">{s().whoLine}</Property>
      <Show when={agent()?.model}>
        <Property label="模型">{agent()!.model}</Property>
      </Show>
      <Show when={!s().inTask}>
        <Property label="交付">
          <Pick
            label="交付"
            value={props.issue.deliver}
            disabled={busy() || !s().open}
            onChange={(v) => {
              const id = props.issue.id;
              void act(() => api.issue.update({ id, body: { deliver: v as Deliverable } }));
            }}
            options={DeliverableValues.map((v) => ({ value: v, label: deliverableLabel[v] }))}
          />
        </Property>
        <Property label="验收">
          <Pick
            label="验收"
            value={props.issue.review}
            disabled={busy() || !s().open}
            onChange={(v) => {
              const id = props.issue.id;
              void act(() => api.issue.update({ id, body: { review: v as Review } }));
            }}
            options={[
              { value: "glance", label: "看一眼就算" },
              { value: "required", label: "必须过验收" },
            ]}
          />
        </Property>
      </Show>
      <More>
        <Show when={s().crewLine}>
          <Property label="一起干活的">{s().crewLine}</Property>
        </Show>
        <Property label="档案">{agent()?.name ?? head().name}</Property>
        <Show when={head().branch}>
          <Property label="分支">
            <span class="font-mono text-xs">{head().branch}</span>
          </Property>
        </Show>
        <Show when={head().worktree}>
          {(worktree) => (
            <Property label="worktree">
              <span class="flex items-start gap-1">
                <span class="min-w-0 flex-1 font-mono text-xs break-all select-text">{worktree()}</span>
                <button
                  type="button"
                  aria-label="复制路径"
                  title="复制路径"
                  onClick={() => void navigator.clipboard?.writeText(worktree())}
                  class="cursor-pointer rounded p-0.5 hover:bg-hover"
                >
                  <Icon name="button-copy" size={14} />
                </button>
              </span>
            </Property>
          )}
        </Show>
        <Property label="用时">{s().usedLine(steps(), now())}</Property>
        <Show when={s().pulled.length > 0}>
          <Property label="已解决的验收意见">
            <For each={s().pulled}>{(f) => <div class="text-faint line-through">{f.text}</div>}</For>
          </Property>
        </Show>
      </More>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

/** A question of the helper's: its options are replies as they are, one click each. */
function Question(props: { ask: Question; busy: boolean; onPick: (words: string) => void }) {
  return (
    <div class="mt-2.5">
      <div>{props.ask.question}</div>
      <Show when={props.ask.options?.length}>
        <div class="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label={`回答：${props.ask.question}`}>
          <For each={props.ask.options}>
            {(o) => (
              <Button disabled={props.busy} onClick={() => props.onPick(o)}>
                {o}
              </Button>
            )}
          </For>
        </div>
      </Show>
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
  const tick = (i: number) =>
    setTicked((t) => {
      const n = new Set(t);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <ul class="flex flex-col">
      <For each={props.rows} keyed={(r) => r.text}>
        {(r, i) => (
          <li class="flex items-start gap-2.5 rounded-md px-1.5 py-1 text-sm">
            <Show when={props.checking}>
              <input
                type="checkbox"
                aria-label={`看过了：${r().text}`}
                checked={ticked().has(i())}
                onChange={() => tick(i())}
                class="mt-0.5 size-4 shrink-0 cursor-pointer accent-leaf"
              />
            </Show>
            <Show when={r().result} fallback={<span class="mt-1 size-3 shrink-0 rounded-full border border-line" title="它还没说" />}>
              {(res) => <Icon name={resultMark[res()].icon} size={14} label={resultMark[res()].label} class="mt-0.5 shrink-0" />}
            </Show>
            <span class="min-w-0 flex-1">
              <span class={{ "text-muted": ticked().has(i()) }}>{r().text}</span>
              <Show when={r().proof}>
                <span class="block text-xs text-muted">{r().proof}</span>
              </Show>
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

/** The milestones, newest first: when, who, what. */
function Story(props: { milestones: Milestone[] }) {
  return (
    <ol class="flex flex-col">
      <For each={props.milestones}>
        {(m) => (
          <li class="flex gap-3 py-1 text-sm">
            <span class="w-16 shrink-0 text-muted">{wallClockText(m.at)}</span>
            <span class={["min-w-0 flex-1 break-words", { "text-berry": m.kind === "failed" || m.kind === "rejected", "font-semibold": m.kind === "asked" }]}>
              <Show when={m.who}>
                <span class="text-muted">{m.who} · </span>
              </Show>
              {m.text}
            </span>
          </li>
        )}
      </For>
    </ol>
  );
}

/** The runs of an issue, read again whenever `version` changes. */
function Runs(props: { issue: string; version: string }) {
  const query = useIssueRuns(
    () => props.issue,
    () => props.version,
  );
  const runs = () => ready(query, []);
  const now = () => Date.now();
  return (
    <Show when={runs().length > 0} fallback={<p class="text-xs text-faint">还没有干过活。</p>}>
      <div>
        <div class="mb-2 text-xs text-muted">{runs().length} 次</div>
        <For each={[...runs()].reverse()}>
          {(r) => (
            <div class="flex gap-3 pb-2 text-sm">
              <span class="w-20 shrink-0 text-muted">{wallClockText(r.startedAt)}</span>
              <span class="min-w-0 flex-1">
                {runText(r, now(), tookText)}
                <Show when={r.summary}>
                  <span class="mt-0.5 line-clamp-2 block text-xs text-muted">{r.summary}</span>
                </Show>
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
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
function WorkLog(props: { steps: SessionEvent[] }) {
  const shown = () => props.steps.filter((e) => stepWord[e.type] !== undefined).slice(-240);
  return (
    <ol class="max-h-[420px] overflow-y-auto font-mono text-xs">
      <For each={shown()}>
        {(e) => (
          <li class="flex gap-2.5 border-b border-line/60 py-1 last:border-b-0">
            <span class="w-14 shrink-0 text-faint">{wallClockText(e.time)}</span>
            <span class={["w-12 shrink-0", e.type === "run/error" ? "text-berry" : e.type === "tool/call" ? "text-water" : "text-muted"]}>
              {stepWord[e.type]}
            </span>
            <span class="line-clamp-3 min-w-0 flex-1 font-sans text-sm break-words whitespace-pre-wrap">
              {e.type === "tool/call" ? (e.actionText ?? e.text) : e.text}
            </span>
          </li>
        )}
      </For>
    </ol>
  );
}

/** An issue for the orchestrator: what it was asked, and its runs; the answers are in its channel. */
export function OrchestratorIssueDetail(props: { issue: Issue }) {
  const tag = () => issueTag(props.issue);
  const [busy, setBusy] = createSignal(false);
  // The orchestrator's answer is the owner's to take as done or put away; one that did not end well can only be put away.
  const go = async (a: IssueAct) => {
    const id = props.issue.id;
    setBusy(true);
    await run(() => api.issue.act({ id, body: { act: a } }));
    setBusy(false);
  };
  return (
    <div>
      <div class="flex items-start gap-3 pr-10">
        <h1 class="flex-1 text-xl font-semibold">{props.issue.title}</h1>
        <span class="mt-1.5 text-xs text-muted">{tagText(props.issue)}</span>
      </div>
      <Show when={props.issue.attention.acts.length > 0}>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <Show when={props.issue.attention.state === "stuck"}>
            <span class="text-sm text-berry">管家这一轮没答成：在频道里看它说了什么</span>
          </Show>
          <For each={props.issue.attention.acts}>
            {(a) => (
              <Button tone={a === props.issue.attention.lead ? "primary" : "plain"} disabled={busy()} onClick={() => void go(a)}>
                {actLabel[a]}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <div class="mt-4">
        <Property label="谁在做">管家</Property>
        <Show when={props.issue.description}>
          <Property label="要做的">
            <span class="text-base">{props.issue.description}</span>
          </Property>
        </Show>
        <Show when={props.issue.recurrence}>
          <Property label="来自">定时：每次到点交给管家，答完等你看</Property>
        </Show>
        <Property label="开单">{wallClockText(props.issue.createdAt)}</Property>
        <Show when={props.issue.closedAt}>{(at) => <Property label="关单">{wallClockText(at())}</Property>}</Show>
        <Property label="回答">在它的频道里</Property>
      </div>
      <h2 class="mt-5 mb-2 text-sm font-semibold">每次干活</h2>
      <Runs issue={props.issue.id} version={`${props.issue.status}:${props.issue.closedAt}:${tagOpen(tag())}`} />
    </div>
  );
}

/** An answer issue's conclusion: the answer, what it rests on, what it is unsure of, what to do next. */
export function AnswerView(props: { answer: IssueAnswer }) {
  const list = (head: string, lines: readonly string[]) => (
    <Show when={lines.length > 0}>
      <div class="mt-2">
        <div class="text-xs text-muted">{head}</div>
        <For each={lines}>{(l) => <div class="text-sm">· {l}</div>}</For>
      </div>
    </Show>
  );
  return (
    <div>
      <p class="text-base">{props.answer.conclusion}</p>
      {list("依据", props.answer.evidence)}
      {list("拿不准的", props.answer.unsure)}
      {list("建议接着做", props.answer.next)}
    </div>
  );
}
