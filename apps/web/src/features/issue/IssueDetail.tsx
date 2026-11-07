import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";

import { list, t } from "@vibevalley/i18n";
import { DeliverableValues, type Issue, type IssueAct, type Session, type SessionView } from "@vibevalley/protocol";
import { closedText, plainText } from "@vibevalley/protocol/rules";

import { useNow } from "#/base/dom.tsx";
import { wallClockText } from "#/base/format.ts";
import { IssueArtifacts } from "#/features/artifact/index.ts";
import { createSessionEvents } from "#/features/session/index.ts";
import { useAgent } from "#/infra/agents.ts";
import { ready } from "#/infra/query.ts";
import { sendReplacing, useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { TextArea } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Markdown } from "#/ui/Markdown.tsx";
import { Dot } from "#/ui/Tag.tsx";
import { toast } from "#/ui/toasts.ts";

import { ActLines } from "./ActLines";
import { createIssueActs } from "./acts";
import { changesLine } from "./changes";
import { ChangesBody, ChangesHead } from "./CloseDialog";
import { useIssueChanges, useIssues, useIssueTimeline } from "./history";
import { AnswerView, Criteria, OrchestratorIssueDetail, Question, Runs, stepsLine, Story, WorkLog } from "./IssueSections";
import { IssueThread } from "./IssueThread";
import { issueMove, movedIssue } from "./moves";
import { issueState, noStepsText, stageTone } from "./overview";
import { Fold, IssueSheet, More, Note, Pick, Property, SheetLabel } from "./Sheet";
import { issueDeliver, shownDeliver } from "./write";

export { AnswerView, OrchestratorIssueDetail };

/** The workbench's issue page, answering the owner top to bottom. the side holds the facts. */
export function IssueDetail(props: {
  issue: Issue;
  sessions: Session[];
  session?: SessionView | undefined;
  onClose: (session: Session, review: boolean) => void;
  onParent?: (() => void) | undefined;
}) {
  const issues = useIssues();
  const now = useNow();
  const moves = useIntents(issueMove);
  const live = () => issues().find((item) => item.id === props.issue.id) ?? props.issue;
  const s = createMemo(() => issueState(movedIssue(live(), moves.list()), props.sessions, props.session, issues()));
  const head = () => s().head;
  // The box under the block holds an answer, the findings of reject, a word to the helper, or what a reopen asks for.
  const acts = createIssueActs(() => props.issue, {
    act: createAct(),
    complete: () => props.onClose(props.session ?? head(), true),
    close: () => props.onClose(props.session ?? head(), false),
    told: (title, description) => toast(t("shared.join.labeled", { label: title, text: description })),
  });
  const { busy, text, setText, box, setBox, go } = acts;
  const delivers = useIntents(issueDeliver);
  const deliver = () => shownDeliver(props.issue.id, props.issue.deliver, delivers.list());
  const doAct = acts.send;
  const sayAct = acts.say;
  const agent = useAgent(() => head().agent);
  const [showSteps, setShowSteps] = createSignal(false);
  const steps = createSessionEvents(() => head().id, showSteps);
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
    <Button data-act={a} tone={lead() ? "primary" : acts.rejecting(a) ? "danger" : "plain"} disabled={acts.disabled(a)} onClick={() => go(a)}>
      {acts.label(a)}
    </Button>
  );

  const parent = () => issues().find((item) => item.id === props.issue.parent);
  const tone = () => stageTone[s().stage.state];
  const heading = (
    <div class="pr-10">
      <Show when={s().inFamily ? props.onParent : undefined}>
        {(onParent) => (
          <button type="button" data-testid="parent-issue" onClick={() => onParent()()} class="mb-1.5 cursor-pointer text-xs text-water hover:underline">
            ‹ {parent()?.title ?? t("web.issue.family.parent")}
          </button>
        )}
      </Show>
      <div class="@container flex flex-wrap items-baseline gap-x-2">
        <span class="shrink-0 text-sm text-muted">#{props.issue.number}</span>
        <h1 class="line-clamp-2 min-w-0 flex-1 text-lg font-semibold" title={s().title}>
          {s().title}
        </h1>
        <span class="shrink-0 text-xs text-muted @max-[560px]:basis-full">
          {[s().repo, t(`shared.priority.${props.issue.priority}`)].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div class="mt-1.5 flex items-center gap-2 text-sm" aria-label={t("web.issue.detail.now")} data-testid="issue-now" data-state={s().stage.state}>
        <Dot tone={tone()} size={8} ring={false} />
        <span>{t(`shared.status.${props.issue.status}`)} ·</span>
        <span class={tone() === "berry" ? "text-berry" : "text-ink/80"}>{s().statusLine(now(), timeline()?.spent?.cny)}</span>
      </div>
    </div>
  );

  const main = (
    <>
      <Show when={s().description}>
        <section data-testid="issue-requirement">
          <SheetLabel>{t("web.issue.detail.full")}</SheetLabel>
          <Markdown class="text-sm text-ink" text={s().description} />
        </section>
      </Show>
      <ActLines issue={props.issue.id} words={acts.words()} onSayAgain={acts.sayAgain} onTakeBack={acts.takeBack} />
      <Show when={s().ask}>
        {(ask) => (
          <section aria-label={t("web.issue.detail.yours")} data-testid="issue-ask" class="mb-5">
            <SheetLabel>{t("web.issue.detail.yours")}</SheetLabel>
            <Note tone={ask().tone}>
              <div class="font-semibold">{ask().head}</div>
              <Show when={ask().line}>{(line) => <div class="mt-1 line-clamp-4">{plainText(line())}</div>}</Show>
              <Show when={s().stage.state === "asking"}>
                <For each={props.issue.questions}>
                  {(a) => <Question ask={a} busy={busy()} onPick={(o) => void doAct("answer", o).then((ok) => ok && setText(""))} />}
                </For>
              </Show>
            </Note>
            <Show when={s().stage.state === "asking" || s().stage.state === "canceled" || box()}>
              <TextArea
                data-testid="issue-words"
                data-box={box()}
                class="mt-2.5"
                rows={box() === "reject" ? 3 : 2}
                value={text()}
                disabled={busy()}
                onInput={(e) => setText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && box() !== "reject" && s().stage.state !== "canceled") {
                    e.preventDefault();
                    sayAct(box() === "tell" ? "tell" : "answer");
                  }
                }}
                placeholder={
                  box() === "reject"
                    ? t("web.issue.detail.rejectWhere")
                    : s().stage.state === "asking"
                      ? t("web.issue.detail.sayIt")
                      : s().stage.state === "canceled"
                        ? t("web.issue.reopen.what")
                        : t("web.issue.detail.tell", { who: head().name })
                }
                aria-label={
                  box() === "reject"
                    ? t("web.issue.detail.rejectLabel")
                    : s().stage.state === "asking"
                      ? t("web.issue.detail.answer")
                      : s().stage.state === "canceled"
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

      <section aria-label={t("web.issue.detail.progress")} data-testid="issue-progress" data-met={s().met} data-total={s().criteria.length}>
        <SheetLabel>
          {t("web.issue.detail.progress")}
          <Show when={s().criteria.length > 0}>
            <span class="ml-2 font-normal">{t("web.issue.detail.met", { met: s().met, of: s().criteria.length })}</span>
          </Show>
        </SheetLabel>
        <Show when={s().doing}>
          <div class="mb-1.5 text-sm text-water">{s().doing}</div>
        </Show>
        <Show when={s().inFamily}>
          <div class="mb-1.5 text-xs text-muted">{s().parentText}</div>
        </Show>
        <Show
          when={s().criteria.length > 0}
          fallback={<p class="text-sm text-muted">{t("web.issue.detail.noCriteria", { answer: props.issue.deliver === "answer" })}</p>}
        >
          <Criteria rows={s().criteria} checking={s().stage.state === "reviewing" && props.issue.reviewedAt === undefined} />
        </Show>
        <Show when={s().openFindings.length > 0}>
          <div class="mt-2">
            <div class="text-xs text-muted">{t("web.issue.detail.rejected")}</div>
            <For each={s().openFindings}>{(f) => <div class="text-sm text-berry">· {f.text}</div>}</For>
          </div>
        </Show>
      </section>

      <section aria-label={t("web.issue.detail.made")} data-testid="issue-made">
        <SheetLabel>{t("web.issue.detail.made")}</SheetLabel>
        <Switch
          fallback={
            <p class="text-sm text-muted">
              {s().stage.state === "done" ? t("shared.join.sentence", { text: closedText(props.issue) }) : t("web.issue.detail.nothingToSee")}
            </p>
          }
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
            <p class="text-sm text-muted">{changesQuery.status() === "pending" ? t("web.issue.reading") : t("web.issue.detail.changesUnread")}</p>
          </Match>
        </Switch>
        <Show when={props.issue.pullRequest}>
          {(pr) => (
            <a href={pr().url} target="_blank" rel="noreferrer" class="mt-1 block text-sm text-water hover:underline">
              {t("shared.join.aside", { text: `PR #${pr().number}`, aside: pr().state })}
            </a>
          )}
        </Show>
      </section>

      <IssueThread issue={props.issue.id} />
      <IssueArtifacts issue={props.issue.id} heading={<SheetLabel>{t("web.artifact.issue.title")}</SheetLabel>} />

      <section aria-label={t("web.issue.detail.story")} data-testid="issue-story">
        <SheetLabel>{t("web.issue.detail.story")}</SheetLabel>
        <Show
          when={timeline()}
          fallback={<p class="text-xs text-faint">{timelineQuery.status() === "pending" ? t("web.issue.reading") : t("web.issue.detail.unread")}</p>}
        >
          {(line) => <Story milestones={line().milestones} />}
        </Show>
        <div class="mt-3 border-t border-line">
          <details onToggle={(event) => setShowSteps(event.currentTarget.open)}>
            <summary class="cursor-pointer py-2.5 text-sm font-semibold">
              {t("web.issue.detail.steps")}
              <Show when={steps().length > 0}>
                <span class="ml-2 font-normal text-muted">{stepsLine(steps())}</span>
              </Show>
            </summary>
            <Show when={showSteps()}>
              <Show when={steps().length > 0 ? steps() : undefined} fallback={<p class="text-xs text-faint">{noStepsText(head())}</p>}>
                {(st) => <WorkLog steps={st()} />}
              </Show>
            </Show>
          </details>
          <Fold label={t("web.issue.detail.runs")} summary={s().historyLine}>
            <Runs issue={props.issue.id} version={`${props.issue.stage.state}:${props.session?.runs}:${props.session?.phase._tag}`} />
          </Fold>
        </div>
      </section>
    </>
  );

  // The acts the block above does not offer: a word, a stop, a close.
  const sideActs = () => {
    const all = s().stage.acts.map((a) => a.act);
    return s().ask ? all.filter((a) => a === "close" || a === "stop") : all;
  };
  const side = (
    <>
      <Show when={sideActs().length > 0}>
        <div class="mb-3 flex flex-wrap gap-2">
          <For each={sideActs()}>{(a) => button(a, () => !s().ask && a === s().lead)}</For>
        </div>
      </Show>
      <SheetLabel>{t("web.issue.detail.time")}</SheetLabel>
      <Property label={t("web.issue.detail.opened")}>{wallClockText(props.issue.createdAt)}</Property>
      <Property label={t("web.issue.detail.started")}>{wallClockText((props.sessions[0] ?? head()).hiredAt)}</Property>
      <Show when={s().ask && s().stage.since}>
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
      <Show when={agent()?.model}>{(model) => <Property label={t("web.issue.detail.model")}>{model()}</Property>}</Show>
      <Show when={!s().inFamily}>
        <Property label={t("web.issue.detail.deliver")}>
          <Pick
            label={t("web.issue.detail.deliver")}
            testid="issue-deliver"
            value={deliver().value}
            state={deliver().state}
            disabled={busy() || !s().open}
            onChange={(v) => {
              const id = props.issue.id;
              sendReplacing(delivers, { id, deliver: v }, (a, b) => a.id === b.id);
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
                  onClick={() => void navigator.clipboard.writeText(worktree())}
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
