import { list, t } from "@vibevalley/i18n";
import type { IconName } from "../../ui/icons";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";

import {
  type Deliverable,
  DeliverableValues,
  type Question,
  type Issue,
  type IssueAct,
  type IssueAction,
  type IssueAnswer,
  type Milestone,
  type Session,
  type SessionEvent,
} from "@vibevalley/protocol";
import { api } from "../../base/api";
import { createIssueActs, perform } from "./acts";
import type { Tone } from "./cards";
import { issueTag, runText, tagOpen, tagText } from "./rules";
import { changesLine, type CriterionRow, issueState, noStepsText, attentionTone } from "./state";
import { closedText } from "@vibevalley/protocol/rules";
import { tookText, wallClockText } from "../../base/format";
import { toast } from "../../ui/toasts";
import { ready } from "../../base/query";
import { useNow } from "../../base/util";
import { Button } from "../../ui/Button";
import { TextArea } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { ChangesBody, ChangesHead } from "./CloseDialog";
import { run, useGraphs } from "./hooks";
import { Fold, IssueSheet, More, Note, Pick, Property, SheetLabel } from "./Sheet";
import { useIssueChanges, useIssueRuns, useIssueTimeline } from "./data";
import { useAgent } from "../../base/agents";
import { createSessionEvents } from "../session";

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
            ‹ {parent()?.title ? t("web.issue.detail.graphStep", { graph: parent()!.title }) : t("web.issue.detail.backToGraph")}
          </button>
        )}
      </Show>
      <div class="@container flex flex-wrap items-baseline gap-x-2">
        <span class="shrink-0 text-sm text-muted">#{props.issue.number}</span>
        <h1 class="line-clamp-2 min-w-0 flex-1 text-lg font-semibold" title={s().title}>
          {s().title}
        </h1>
        <span class="shrink-0 text-xs text-muted @max-[560px]:basis-full">
          {[s().project, t(`shared.priority.${props.issue.priority}`)].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div class="mt-1.5 flex items-center gap-2 text-sm" aria-label={t("web.issue.detail.now")}>
        <Dot tone={tone()} />
        <span class={tone() === "berry" ? "text-berry" : "text-ink/80"}>{s().statusLine(now(), timeline()?.spent?.cny)}</span>
      </div>
    </div>
  );

  const main = (
    <>
      <Show when={s().ask}>
        {(ask) => (
          <section aria-label={t("web.issue.detail.yours")} class="mb-5">
            <SheetLabel>{t("web.issue.detail.yours")}</SheetLabel>
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
                    ? t("web.issue.detail.rejectWhere")
                    : s().attention.state === "asking"
                      ? t("web.issue.detail.sayIt")
                      : s().attention.state === "canceled"
                        ? t("web.issue.reopen.what")
                        : t("web.issue.detail.tell", { who: head().name })
                }
                aria-label={
                  box() === "reject"
                    ? t("web.issue.detail.rejectLabel")
                    : s().attention.state === "asking"
                      ? t("web.issue.detail.answer")
                      : s().attention.state === "canceled"
                        ? t("web.issue.reopen.title")
                        : t("web.issue.detail.tell", { who: head().name })
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
        <section aria-label={t("web.issue.detail.tellSection")} class="mb-5">
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
            placeholder={head().phase._tag === "working" ? t("web.issue.detail.tellWorking") : t("web.issue.detail.tellIdle")}
            aria-label={t("web.issue.detail.tell", { who: head().name })}
            autofocus
          />
          <div class="mt-2 flex gap-2">
            {button("tell", () => true)}
            <Button disabled={busy()} onClick={() => setBox(undefined)}>
              {t("web.issue.never")}
            </Button>
          </div>
        </section>
      </Show>

      <section aria-label={t("web.issue.detail.progress")}>
        <SheetLabel>
          {t("web.issue.detail.progress")}
          <Show when={s().criteria.length > 0}>
            <span class="ml-2 font-normal">{t("web.issue.detail.met", { met: s().met, of: s().criteria.length })}</span>
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
          fallback={<p class="text-sm text-muted">{t("web.issue.detail.noCriteria", { answer: props.issue.deliver === "answer" })}</p>}
        >
          <Criteria rows={s().criteria} checking={s().attention.state === "reviewing" && props.issue.reviewedAt === undefined} />
        </Show>
        <Show when={s().openFindings.length > 0}>
          <div class="mt-2">
            <div class="text-xs text-muted">{t("web.issue.detail.rejected")}</div>
            <For each={s().openFindings}>{(f) => <div class="text-sm text-berry">· {f.text}</div>}</For>
          </div>
        </Show>
      </section>

      <section aria-label={t("web.issue.detail.made")}>
        <SheetLabel>{t("web.issue.detail.made")}</SheetLabel>
        <Switch
          fallback={<p class="text-sm text-muted">{s().attention.state === "done" ? closedText(props.issue) + "。" : t("web.issue.detail.nothingToSee")}</p>}
        >
          <Match when={props.issue.deliver === "answer"}>
            <Show when={props.issue.answer} fallback={<p class="text-sm text-muted">{t("web.issue.detail.noAnswer")}</p>}>
              {(a) => <AnswerView answer={a()} />}
            </Show>
          </Match>
          <Match when={s().showsChanges && changes()}>
            {(c) => (
              <Show
                when={c().commits.length > 0 || c().uncommitted.length > 0 || c().files.length > 0}
                fallback={<p class="text-sm text-muted">{t("web.issue.detail.noChanges")}</p>}
              >
                <div class="flex flex-col gap-2">
                  <div class="text-sm">{changesLine(c())}</div>
                  <Show when={c().conflicts.length > 0}>
                    <div class="text-sm text-berry">{t("web.issue.detail.conflict", { base: c().base, files: list(c().conflicts) })}</div>
                  </Show>
                  <Fold label={t("web.issue.detail.changedFiles")} summary={t("web.issue.detail.fileCount", { n: c().files.length })}>
                    <ChangesHead changes={c()} />
                    <ChangesBody changes={c()} />
                  </Fold>
                </div>
              </Show>
            )}
          </Match>
          <Match when={s().showsChanges}>
            <p class="text-sm text-muted">{changesQuery.isPending ? t("web.issue.reading") : t("web.issue.detail.changesUnread")}</p>
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

      <section aria-label={t("web.issue.detail.story")}>
        <SheetLabel>{t("web.issue.detail.story")}</SheetLabel>
        <Show when={timeline()} fallback={<p class="text-xs text-faint">{timelineQuery.isPending ? t("web.issue.reading") : t("web.issue.detail.unread")}</p>}>
          {(line) => <Story milestones={line().milestones} />}
        </Show>
        <div class="mt-3 border-t border-line">
          <Show when={s().description}>
            <Fold label={t("web.issue.detail.full")}>
              <Markdown class="text-sm text-ink/90" text={s().description} />
            </Fold>
          </Show>
          <Fold label={t("web.issue.detail.steps")} summary={steps().length ? stepsLine(steps()) : undefined}>
            <Show when={steps().length ? steps() : undefined} fallback={<p class="text-xs text-faint">{noStepsText(head())}</p>}>
              {(st) => <WorkLog steps={st()} />}
            </Show>
          </Fold>
          <Fold label={t("web.issue.detail.runs")} summary={s().historyLine}>
            <Runs issue={props.issue.id} version={`${props.issue.attention.state}:${props.session?.runs}:${props.session?.phase._tag}`} />
          </Fold>
        </div>
      </section>
    </>
  );

  // The acts the block above does not offer: a word, a stop, a close.
  const sideActs = () => {
    const all = s().attention.acts.map((a) => a.act);
    return s().ask ? all.filter((a) => a === "close" || a === "stop") : all;
  };
  const side = (
    <>
      <Show when={sideActs().length > 0}>
        <div class="mb-3 flex flex-col gap-2">
          <For each={sideActs()}>{(a) => button(a, () => !s().ask && a === s().lead)}</For>
        </div>
      </Show>
      <SheetLabel>{t("web.issue.detail.time")}</SheetLabel>
      <Property label={t("web.issue.detail.opened")}>{wallClockText(props.issue.createdAt)}</Property>
      <Property label={t("web.issue.detail.started")}>{wallClockText(props.sessions[0]!.hiredAt)}</Property>
      <Show when={s().ask && s().attention.since}>
        {(at) => <Property label={t("web.issue.detail.waiting")}>{t("web.issue.detail.since", { clock: wallClockText(at()) })}</Property>}
      </Show>
      <Show when={props.issue.reviewedAt}>
        {(at) => (
          <Property label={t("web.issue.detail.reviewed")}>
            <span class="text-accent">{wallClockText(at())}</span>
          </Property>
        )}
      </Show>
      <Show when={props.issue.closedAt}>{(at) => <Property label={t("web.issue.detail.closedAt")}>{wallClockText(at())}</Property>}</Show>
      <SheetLabel>{t("web.issue.detail.who")}</SheetLabel>
      <Property label={t("web.issue.detail.helper")}>{s().whoLine}</Property>
      <Show when={agent()?.model}>
        <Property label={t("web.issue.detail.model")}>{agent()!.model}</Property>
      </Show>
      <Show when={!s().inTask}>
        <Property label={t("web.issue.detail.deliver")}>
          <Pick
            label={t("web.issue.detail.deliver")}
            value={props.issue.deliver}
            disabled={busy() || !s().open}
            onChange={(v) => {
              const id = props.issue.id;
              void act(() => api.issue.update({ id, deliver: v as Deliverable }));
            }}
            options={DeliverableValues.map((v) => ({ value: v, label: t(`shared.deliverable.${v}`) }))}
          />
        </Property>
      </Show>
      <More>
        <Show when={s().crewLine}>
          <Property label={t("web.issue.detail.crew")}>{s().crewLine}</Property>
        </Show>
        <Property label={t("web.issue.detail.profile")}>{agent()?.name ?? head().name}</Property>
        <Show when={head().branch}>
          <Property label={t("web.issue.detail.branch")}>
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
                  aria-label={t("web.issue.detail.copyPath")}
                  title={t("web.issue.detail.copyPath")}
                  onClick={() => void navigator.clipboard?.writeText(worktree())}
                  class="cursor-pointer rounded p-0.5 hover:bg-hover"
                >
                  <Icon name="copy" size={14} />
                </button>
              </span>
            </Property>
          )}
        </Show>
        <Property label={t("web.issue.detail.took")}>{s().usedLine(steps(), now())}</Property>
        <Show when={s().resolvedFindings.length > 0}>
          <Property label={t("web.issue.detail.resolved")}>
            <For each={s().resolvedFindings}>{(f) => <div class="text-faint line-through">{f.text}</div>}</For>
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
        <div class="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label={t("web.issue.detail.answerTo", { question: props.ask.question })}>
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

const resultMark: Record<NonNullable<CriterionRow["result"]>, { icon: IconName; label: string }> = {
  met: { icon: "check", label: t("web.issue.detail.result.met") },
  unmet: { icon: "cross", label: t("web.issue.detail.result.unmet") },
  unsure: { icon: "warn", label: t("web.issue.detail.result.unsure") },
};

/** The criteria with the helper's word on each; while it is judged, each can be ticked off as the owner checks it (on
 * this page only). */
function Criteria(props: { rows: CriterionRow[]; checking: boolean }) {
  const [ticked, setTicked] = createSignal<ReadonlySet<number>>(new Set());
  const tick = (i: number) =>
    setTicked((was) => {
      const n = new Set(was);
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
                aria-label={t("web.issue.detail.ticked", { criterion: r().text })}
                checked={ticked().has(i())}
                onChange={() => tick(i())}
                class="mt-0.5 size-4 shrink-0 cursor-pointer accent-leaf"
              />
            </Show>
            <Show when={r().result} fallback={<span class="mt-1 size-3 shrink-0 rounded-full border border-line" title={t("web.issue.detail.unsaid")} />}>
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
    <Show when={runs().length > 0} fallback={<p class="text-xs text-faint">{t("web.issue.detail.noRuns")}</p>}>
      <div>
        <div class="mb-2 text-xs text-muted">{t("web.issue.detail.runCount", { n: runs().length })}</div>
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
  return tools === 0 ? t("web.issue.detail.stepCount", { n: steps.length }) : t("web.issue.detail.stepsAndTools", { n: steps.length, tools });
};

const stepWord: Partial<Record<SessionEvent["type"], string>> = {
  "run/start": t("web.issue.detail.step.run/start"),
  "user/message": t("web.issue.detail.step.user/message"),
  "memory/recalled": t("web.issue.detail.step.memory/recalled"),
  "assistant/thinking": t("web.issue.detail.step.assistant/thinking"),
  "assistant/message": t("web.issue.detail.step.assistant/message"),
  "tool/call": t("web.issue.detail.step.tool/call"),
  "llm/retry": t("web.issue.detail.step.llm/retry"),
  "run/error": t("web.issue.detail.step.run/error"),
  "run/end": t("web.issue.detail.step.run/end"),
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
  const go = async (a: IssueAction) => {
    const issue = props.issue;
    setBusy(true);
    await run(() => perform(issue, a));
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
            <span class="text-sm text-berry">{t("web.issue.detail.orchestratorStuck")}</span>
          </Show>
          <For each={props.issue.attention.acts}>
            {(a) => (
              <Button tone={a.act === props.issue.attention.lead ? "primary" : "plain"} disabled={busy()} onClick={() => void go(a)}>
                {t(`shared.act.${a.act}`)}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <div class="mt-4">
        <Property label={t("web.issue.detail.who")}>{t("web.issue.orchestrator")}</Property>
        <Show when={props.issue.description}>
          <Property label={t("web.issue.detail.job")}>
            <span class="text-base">{props.issue.description}</span>
          </Property>
        </Show>
        <Show when={props.issue.recurrence}>
          <Property label={t("web.issue.detail.from")}>{t("web.issue.detail.fromRecurrence")}</Property>
        </Show>
        <Property label={t("web.issue.detail.opened")}>{wallClockText(props.issue.createdAt)}</Property>
        <Show when={props.issue.closedAt}>{(at) => <Property label={t("web.issue.detail.closedAt")}>{wallClockText(at())}</Property>}</Show>
        <Property label={t("web.issue.detail.answer")}>{t("web.issue.detail.answered")}</Property>
      </div>
      <h2 class="mt-5 mb-2 text-sm font-semibold">{t("web.issue.detail.runs")}</h2>
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
      {list(t("web.issue.detail.evidence"), props.answer.evidence)}
      {list(t("web.issue.detail.unsure"), props.answer.unsure)}
      {list(t("web.issue.detail.next"), props.answer.next)}
    </div>
  );
}
