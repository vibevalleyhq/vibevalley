import { Clipboard, keymap, signal, Text, View, type ViewRef } from "nsh";

import { list, t } from "@vibevalley/i18n";
import { DeliverableValues, type Issue, type IssueAct, PriorityValues, type Session, type SessionView } from "@vibevalley/protocol";
import { closedText, plainText, sessionBranch, sessionProfile, sessionWorktree } from "@vibevalley/protocol/rules";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { OpenTerminal } from "../../../design/domain/OpenTerminal";
import { TextArea, TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { Markdown } from "../../../design/Markdown";
import { motionClass } from "../../../design/motion";
import { Dot } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { useAgent } from "../../../infra/agents";
import { useNow } from "../../../infra/base/dom";
import { shortMomentText } from "../../../infra/base/format";
import { hostApi } from "../../../infra/bridge";
import { useCore } from "../../../infra/frame";
import { ready } from "../../../infra/query";
import { Link as A } from "../../../infra/router";
import { createMemo } from "../../../infra/solid";
import { useIntents } from "../../../infra/state/intent";
import { IssueArtifacts } from "../../artifact";
import { runsHref } from "../../session";
import { createSessionEvents } from "../../session/events";
import { SubagentProgress } from "../../session/SubagentProgress";
import { createIssueActs } from "../model/acts";
import { changesLine } from "../model/changes";
import { useIssueChanges, useIssues, useIssueTimeline } from "../model/history";
import { issueMove, movedIssue } from "../model/moves";
import { issueState, noStepsText, stageTone } from "../model/overview";
import { issueSet, labeledIssue, sendLabel } from "../model/write";
import { ActLines } from "./ActLines";
import { ChangesBody, ChangesHead, ConflictFiles } from "./CloseDialog";
import { AnswerView, Criteria, OrchestratorIssueDetail, Question, ReconcileWorktree, Runs, stepsLine, Story, WorkLog } from "./IssueSections";
import { IssueThread } from "./IssueThread";
import { Fold, IssueSheet, More, Note, Pick, Property, SheetLabel } from "./Sheet";

export { OrchestratorIssueDetail };

/** The workbench's issue page, answering the user top to bottom. the side holds the facts. */
export function IssueDetail(props: {
  issue: Issue;
  sessions: Session[];
  session?: SessionView | undefined;
  onClose: (session: Session, review: boolean) => void;
  onParent?: (() => void) | undefined;
}) {
  const core = useCore();
  const issues = useIssues();
  const now = useNow();
  const moves = useIntents(issueMove);
  const sets = useIntents(issueSet);
  const labeled = () => labeledIssue(issues().find((item) => item.id === props.issue.id) ?? props.issue, sets.list());
  const live = () => labeled().issue;
  const s = createMemo(() => issueState(movedIssue(live(), moves.list()), props.sessions, props.session, issues(), core()?.boardSummary));
  const head = () => s().head;
  // The box under the block holds an answer, the findings of reject, a word to the helper, or what a reopen asks for.
  const acts = createIssueActs(() => props.issue, {
    act: createAct(),
    complete: () => props.onClose(props.session ?? head(), true),
    close: () => props.onClose(props.session ?? head(), false),
    told: (title, description) => toast(t("shared.join.labeled", { label: title, text: description })),
  });
  const { busy, text, setText, box, setBox, go } = acts;
  const setLabel = (label: Omit<Parameters<typeof sendLabel>[1], "id">) => void sendLabel(sets, { id: props.issue.id, ...label });
  const doAct = acts.send;
  const sayAct = acts.say;
  const agent = useAgent(() => sessionProfile(head()));
  const showSteps = signal(false);
  const steps = createSessionEvents(() => head().id, showSteps);
  const changesQuery = useIssueChanges(
    () => props.issue.id,
    () => s().showsChanges,
  );
  const changes = () => ready(changesQuery, undefined);
  const filesOpen = signal(false);
  let changesSection: ViewRef | undefined;
  const reviewChanges = () => {
    filesOpen.set(true);
    requestAnimationFrame(() => changesSection?.reveal({ vertical: "nearest" }));
  };
  const changesAction = () => (live().deliver !== "answer" && s().showsChanges ? reviewChanges : undefined);
  const timelineQuery = useIssueTimeline(
    () => props.issue,
    () => head().runs,
  );
  const timeline = () => ready(timelineQuery, undefined);

  /** lead is read as it renders: the lead changes as the issue moves on. */
  const button = (a: IssueAct, lead: () => boolean) => (
    <Button
      testID={`act-${a}`}
      tone={lead() ? "primary" : acts.rejecting(a) || a === "close" ? "danger" : "plain"}
      disabled={acts.disabled(a)}
      onPress={() => go(a)}
    >
      {acts.label(a)}
    </Button>
  );

  const copyText = (value: string) => {
    void Clipboard.writeText(value);
    toast(t("web.base.rich.copied"));
  };

  const parent = () => issues().find((item) => item.id === props.issue.parent);
  const tone = () => stageTone[s().stage.state];
  const heading = (
    <View>
      <View accessibilityLabel={t("web.issue.detail.trail")} testID="issue-trail" class="mb-1.5 flex-row flex-wrap items-center gap-1">
        <Text class="text-xs text-muted">{s().repo || t("web.issue.detail.noRepo")}</Text>
        <If when={s().inFamily ? props.onParent : undefined}>
          {(onParent) => (
            <>
              <Icon name="next" size={12} tone="muted" />
              <View role="button" testID="parent-issue" onPress={() => onParent()()} class="-mx-1 rounded-sm px-1 py-0.5 hover:bg-hover">
                <Text class="text-xs text-water">{parent()?.title ?? t("web.issue.family.parent")}</Text>
              </View>
            </>
          )}
        </If>
        <Icon name="next" size={12} tone="muted" />
        <Text class="shrink-0 font-mono text-xs text-muted tabular-nums">{`#${props.issue.number}`}</Text>
      </View>
      <View class="flex-row flex-wrap items-baseline gap-x-2">
        <IssueTitle shown={s().title} full={live().title} editable={s().open} state={labeled().state("title")} onSave={(title) => setLabel({ title })} />
      </View>
      <View class="mt-2 flex-row items-start gap-2" accessibilityLabel={t("web.issue.detail.now")} testID="issue-now">
        <View class="mt-1.5">
          <Dot tone={tone()} size={8} ring={false} />
        </View>
        {/* Each part whole: a narrow screen wraps between them, not inside "第 1 轮". */}
        <View class="min-w-0 flex-1 flex-row flex-wrap">
          <Each of={s().statusParts(now(), timeline()?.spent?.cny)}>
            {(part, i) => (
              <Text class={`text-sm tabular-nums ${tone() === "berry" ? "text-berry" : "text-ink"}`} style={tone() === "berry" ? undefined : { opacity: 0.8 }}>
                {`${i() > 0 ? " · " : ""}${part()}`}
              </Text>
            )}
          </Each>
        </View>
      </View>
    </View>
  );

  const placeholder = () =>
    box() === "reject"
      ? t("web.issue.detail.rejectWhere")
      : s().stage.state === "asking"
        ? t("web.issue.detail.sayIt")
        : s().stage.state === "canceled"
          ? t("web.issue.reopen.what")
          : t("web.issue.detail.tell", { who: head().name });
  const boxLabel = () =>
    box() === "reject"
      ? t("web.issue.detail.rejectLabel")
      : s().stage.state === "asking"
        ? t("web.issue.detail.answer")
        : s().stage.state === "canceled"
          ? t("web.issue.reopen.title")
          : t("web.issue.detail.tell", { who: head().name });

  const failedCheck = () => {
    const check = live().deliveryEvidence?.check;
    return check?.status === "failed" ? check : undefined;
  };
  const main = (
    <>
      <If when={failedCheck()}>
        {(check) => (
          <Note tone="berry" class="mb-4">
            <Fold
              testID="failed-project-check"
              defaultOpen
              label={t("web.issue.changes.projectCheck")}
              summary={`${t("web.issue.changes.check.failed")} · ${check().candidateCommit.slice(0, 12)}`}
            >
              <If when={check().command}>{(command) => <Text class="font-mono text-xs text-ink">{command()}</Text>}</If>
              <If when={check().output}>
                {(output) => (
                  <Text testID="failed-check-output" class="mt-1 font-mono text-xs text-ink">
                    {output()}
                  </Text>
                )}
              </If>
            </Fold>
          </Note>
        )}
      </If>
      <If when={s().description}>
        <View testID="issue-requirement">
          <SheetLabel first={!failedCheck()}>{t("web.issue.detail.full")}</SheetLabel>
          <Markdown size="sm" text={s().description} />
        </View>
      </If>
      <If when={s().needsWorktreeCheck}>
        <ReconcileWorktree onChanges={changesAction()} />
      </If>
      <If when={head().subagents}>{(progress) => <SubagentProgress session={head().id} progress={progress()} now={now()} />}</If>
      <ActLines issue={props.issue.id} words={acts.words()} onSayAgain={acts.sayAgain} onTakeBack={acts.takeBack} />
      <If when={s().ask}>
        {(ask) => (
          <View accessibilityLabel={t("web.issue.detail.yours")} testID="issue-ask" class="mb-5">
            <SheetLabel first={!failedCheck() && !s().description}>{t("web.issue.detail.yours")}</SheetLabel>
            <Note tone={ask().tone}>
              <Text class="text-sm font-semibold text-ink">{ask().head}</Text>
              <If
                when={live().conflict}
                else={<If when={ask().line}>{(line) => <Text class="mt-1 line-clamp-4 text-sm text-ink">{plainText(line())}</Text>}</If>}
              >
                {(conflict) => <ConflictFiles files={conflict().files} worktree={sessionWorktree(head())} />}
              </If>
              <If when={s().stage.state === "asking"}>
                <Each of={props.issue.questions}>
                  {(a) => <Question ask={a()} busy={busy()} onPick={(o) => void doAct("answer", o).then((ok) => ok && setText(""))} />}
                </Each>
              </If>
            </Note>
            <If when={s().stage.state === "asking" || s().stage.state === "canceled" || box()}>
              <TextArea
                testID="issue-words"
                class="mt-2.5"
                rows={box() === "reject" ? 3 : 2}
                value={text()}
                disabled={busy()}
                onInput={setText}
                // Return says it (Shift+Return breaks the line), but not the findings of a reject or a reopen's words.
                submit={box() !== "reject" && s().stage.state !== "canceled"}
                onSubmit={() => sayAct(box() === "tell" ? "tell" : "answer")}
                placeholder={placeholder()}
                accessibilityLabel={boxLabel()}
              />
            </If>
            <View class="mt-2.5 flex-row flex-wrap gap-2">
              {/* Keyed by the act, as VibeValley's keyed Show: another lead is another button. */}
              <Each of={((l) => (l ? [l] : []))(s().lead)}>{(lead) => button(lead(), () => true)}</Each>
              <Each of={s().others.filter((a) => a !== "close" && a !== "stop")}>{(a) => button(a(), () => false)}</Each>
            </View>
          </View>
        )}
      </If>
      <If when={!s().ask && box() === "tell"}>
        <View accessibilityLabel={t("web.issue.detail.tellSection")} class="mb-5">
          <TextArea
            testID="issue-tell"
            rows={2}
            value={text()}
            disabled={busy()}
            onInput={setText}
            submit
            onSubmit={() => sayAct("tell")}
            placeholder={head().phase._tag === "working" ? t("web.issue.detail.tellWorking") : t("web.issue.detail.tellIdle")}
            accessibilityLabel={t("web.issue.detail.tell", { who: head().name })}
            autoFocus
          />
          <View class="mt-2 flex-row gap-2">
            {button("tell", () => true)}
            <Button disabled={busy()} onPress={() => setBox(undefined)}>
              {t("web.issue.never")}
            </Button>
          </View>
        </View>
      </If>

      <View accessibilityLabel={t("web.issue.detail.progress")} testID="issue-progress">
        <View class={`${!failedCheck() && !s().description && !s().ask ? "mt-0" : "mt-6"} mb-2 flex-row items-baseline gap-2`}>
          <Text class="text-xs font-semibold text-muted">{t("web.issue.detail.progress")}</Text>
          <If when={s().criteria.length > 0}>
            <Text class="text-xs text-muted tabular-nums">{t("web.issue.detail.met", { met: s().met, of: s().criteria.length })}</Text>
          </If>
        </View>
        <If when={s().doing}>
          <Text class="mb-1.5 text-sm text-water">{s().doing}</Text>
        </If>
        <If when={s().inFamily}>
          <Text class="mb-1.5 text-xs text-muted">{s().parentText}</Text>
        </If>
        <If
          when={s().criteria.length > 0}
          else={<Text class="text-sm text-muted">{t("web.issue.detail.noCriteria", { answer: live().deliver === "answer" })}</Text>}
        >
          <Criteria rows={s().criteria} checking={s().stage.state === "reviewing" && props.issue.reviewedAt === undefined} />
        </If>
        <If when={s().openFindings.length > 0}>
          <View class="mt-2">
            <Text class="text-xs text-muted">{t("web.issue.detail.rejected")}</Text>
            <Each of={s().openFindings}>{(f) => <Text class="text-sm text-berry">{`· ${f().text}`}</Text>}</Each>
          </View>
        </If>
      </View>

      <View
        accessibilityLabel={t("web.issue.detail.made")}
        testID="issue-made"
        ref={(node) => {
          changesSection = node;
        }}
      >
        <SheetLabel>{t("web.issue.detail.made")}</SheetLabel>
        <If
          when={live().deliver === "answer"}
          else={
            <If
              when={s().showsChanges ? changes() : undefined}
              else={
                <If
                  when={s().showsChanges}
                  else={
                    <Text class="text-sm text-muted">
                      {s().stage.state === "done" ? t("shared.join.sentence", { text: closedText(props.issue) }) : t("web.issue.detail.nothingToSee")}
                    </Text>
                  }
                >
                  <Text class="text-sm text-muted">{changesQuery.status() === "pending" ? t("web.issue.reading") : t("web.issue.detail.changesUnread")}</Text>
                </If>
              }
            >
              {(c) => (
                <If
                  when={c().commits.length > 0 || c().uncommitted.length > 0 || c().files.length > 0}
                  else={<Text class="text-sm text-muted">{t("web.issue.detail.noChanges")}</Text>}
                >
                  <View class="gap-2">
                    <Text class="text-sm text-ink tabular-nums">{changesLine(c())}</Text>
                    <If when={c().conflicts.length > 0}>
                      <Text class="text-sm text-berry">{t("web.issue.detail.conflict", { base: c().base, files: list(c().conflicts) })}</Text>
                    </If>
                    <Fold
                      testID="changed-files"
                      open={filesOpen()}
                      onToggle={(v) => filesOpen.set(v)}
                      label={t("web.issue.detail.changedFiles")}
                      summary={t("web.issue.detail.fileCount", { n: c().files.length })}
                    >
                      <ChangesHead changes={c()} />
                      <ChangesBody changes={c()} />
                    </Fold>
                  </View>
                </If>
              )}
            </If>
          }
        >
          <If when={props.issue.answer} else={<Text class="text-sm text-muted">{t("web.issue.detail.noAnswer")}</Text>}>
            {(a) => <AnswerView answer={a()} />}
          </If>
        </If>
        <If when={props.issue.pullRequest}>
          {(pr) => (
            <View role="link" class="-mx-1 mt-1 self-start rounded-sm px-1 py-0.5 hover:bg-hover" onPress={() => void hostApi.openUrl(pr().url)}>
              <Text class="text-sm text-water">{t("shared.join.aside", { text: `PR #${pr().number}`, aside: pr().state })}</Text>
            </View>
          )}
        </If>
      </View>

      <IssueThread issue={props.issue.id} />
      <IssueArtifacts issue={props.issue.id} heading={<SheetLabel>{t("web.artifact.issue.title")}</SheetLabel>} />

      <View accessibilityLabel={t("web.issue.detail.story")} testID="issue-story">
        <SheetLabel>{t("web.issue.detail.story")}</SheetLabel>
        <If
          when={timeline()}
          else={<Text class="text-xs text-faint">{timelineQuery.status() === "pending" ? t("web.issue.reading") : t("web.issue.detail.unread")}</Text>}
        >
          {(line) => <Story milestones={line().milestones} />}
        </If>
        <View class="mt-3 border-t border-line">
          <Fold
            testID="issue-steps-fold"
            label={t("web.issue.detail.steps")}
            summary={steps().length > 0 ? stepsLine(steps()) : undefined}
            aside={
              <A
                href={runsHref({ session: head().id, issue: props.issue.id })}
                testID="issue-open-trajectory"
                class={`h-6 shrink-0 flex-row items-center gap-1 rounded-md px-2 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
              >
                <Icon name="log" size={12} tone="muted" />
                <Text class="text-xs font-medium text-muted">{t("web.issue.detail.openTrajectory")}</Text>
              </A>
            }
            onToggle={(v) => showSteps.set(v)}
          >
            <If when={steps().length > 0 ? steps() : undefined} else={<Text class="text-xs text-faint">{noStepsText(head())}</Text>}>
              {(st) => <WorkLog steps={st()} />}
            </If>
          </Fold>
          <Fold label={t("web.issue.detail.runs")} summary={s().historyLine} testID="issue-runs-fold">
            <Runs
              issue={props.issue.id}
              version={`${props.issue.stage.state}:${props.session?.runs}:${props.session?.phase._tag}`}
              onChanges={changesAction()}
            />
          </Fold>
        </View>
      </View>
    </>
  );

  // The acts the block above does not offer: a word, a stop, a close.
  const sideActs = () => {
    const all = s().stage.acts.map((a) => a.act);
    return s().ask ? all.filter((a) => a === "close" || a === "stop") : all;
  };
  // Destructive close lives in the danger button below: listing it here too would duplicate it.
  const statusMoves = () => s().stage.acts.flatMap((a) => (a.does === "move" && a.act !== "close" ? [{ act: a.act, status: a.status }] : []));
  // Two acts to one status (reject and resume both go back to work) say which act each is.
  const statusOptions = () => {
    const moves = statusMoves();
    const options: { value: IssueAct | "now"; label: string }[] = [{ value: "now", label: t(`shared.status.${live().status}`) }];
    for (const m of moves) {
      const status = t(`shared.status.${m.status}`);
      const shared = moves.filter((o) => o.status === m.status).length > 1;
      options.push({ value: m.act, label: shared ? t("shared.join.aside", { text: status, aside: acts.label(m.act) }) : status });
    }
    return options;
  };
  const distinctProfile = () => {
    const name = agent()?.name;
    return name && name !== head().name ? name : undefined;
  };
  const side = (
    <>
      <SheetLabel first>{t("web.issue.detail.properties")}</SheetLabel>
      <Property label={t("web.issue.detail.status")}>
        <Pick<IssueAct | "now">
          label={t("web.issue.detail.status")}
          testid="issue-status"
          value="now"
          state={acts.moving()}
          disabled={busy() || statusMoves().length === 0}
          onChange={(a) => a !== "now" && go(a)}
          options={statusOptions()}
        />
      </Property>
      <Property label={t("web.issue.detail.priority")}>
        <Pick
          label={t("web.issue.detail.priority")}
          testid="issue-priority"
          value={live().priority}
          state={labeled().state("priority")}
          disabled={!s().open}
          onChange={(priority) => setLabel({ priority })}
          options={PriorityValues.map((v) => ({ value: v, label: t(`shared.priority.${v}`) }))}
        />
      </Property>
      <If when={!s().inFamily}>
        <Property label={t("web.issue.detail.deliver")}>
          <Pick
            label={t("web.issue.detail.deliver")}
            testid="issue-deliver"
            value={live().deliver}
            state={labeled().state("deliver")}
            disabled={busy() || !s().open}
            onChange={(deliver) => setLabel({ deliver })}
            options={DeliverableValues.map((v) => ({ value: v, label: t(`shared.deliverable.${v}`) }))}
          />
        </Property>
      </If>
      <Property label={t("web.issue.detail.repo")}>{s().repo || t("web.issue.detail.noRepo")}</Property>
      <Property label={t("web.issue.detail.helper")}>{s().whoLine}</Property>
      <If when={agent()?.model}>{(model) => <Property label={t("web.issue.detail.model")}>{model()}</Property>}</If>
      <If when={sideActs().length > 0 || sessionWorktree(head())}>
        <View class="mt-3 flex-row flex-wrap items-center gap-2">
          <Each of={sideActs()}>{(a) => button(a(), () => !s().ask && a() === s().lead)}</Each>
          <If when={sessionWorktree(head())}>
            {(worktree) => <OpenTerminal cwd={worktree()} title={`#${props.issue.number}`} testid="issue-open-workspace" />}
          </If>
        </View>
      </If>
      <SheetLabel divider>{t("web.issue.detail.time")}</SheetLabel>
      <Property label={t("web.issue.detail.opened")}>
        <Text class="text-sm text-ink tabular-nums">{shortMomentText(props.issue.createdAt, now())}</Text>
      </Property>
      <Property label={t("web.issue.detail.started")}>
        <Text class="text-sm text-ink tabular-nums">{shortMomentText((props.sessions[0] ?? head()).hiredAt, now())}</Text>
      </Property>
      <If when={s().ask && s().stage.since}>
        {(at) => (
          <Property label={t("web.issue.detail.waiting")}>
            <Text class="text-sm text-ink tabular-nums">{t("web.issue.detail.since", { clock: shortMomentText(at(), now()) })}</Text>
          </Property>
        )}
      </If>
      <If when={live().deliveryEvidence?.reviews.at(-1)}>
        {(review) => (
          <Property label={t("web.issue.changes.reviewVersion")}>
            <Text class="font-mono text-xs text-ink">{`${review().revision.baseCommit.slice(0, 8)} → ${review().revision.tree.slice(0, 12)}`}</Text>
          </Property>
        )}
      </If>
      <If when={!failedCheck() ? live().deliveryEvidence?.check : undefined}>
        {(check) => (
          <Property label={t("web.issue.changes.projectCheck")}>
            {`${t(`web.issue.changes.check.${check().status}`)} · ${check().candidateCommit.slice(0, 12)}`}
          </Property>
        )}
      </If>
      <If when={!failedCheck() ? live().deliveryEvidence?.check?.output : undefined}>
        {(output) => (
          <Fold label={t("web.issue.changes.checkOutput")}>
            <Text class="font-mono text-xs text-ink">{output()}</Text>
          </Fold>
        )}
      </If>
      <If when={live().deliveryEvidence?.mergedCommit}>
        {(commit) => (
          <Property label={t("web.issue.changes.mergedCommit")}>
            <Text class="font-mono text-xs text-ink">{commit().slice(0, 12)}</Text>
          </Property>
        )}
      </If>
      <If when={props.issue.reviewedAt}>
        {(at) => (
          <Property label={t("web.issue.detail.reviewed")}>
            <Text class="text-sm text-accent tabular-nums">{shortMomentText(at(), now())}</Text>
          </Property>
        )}
      </If>
      <If when={props.issue.closedAt}>
        {(at) => (
          <Property label={t("web.issue.detail.closedAt")}>
            <Text class="text-sm text-ink tabular-nums">{shortMomentText(at(), now())}</Text>
          </Property>
        )}
      </If>
      <More>
        <If when={s().crewLine}>
          <Property label={t("web.issue.detail.crew")}>{s().crewLine}</Property>
        </If>
        <If when={distinctProfile()}>{(profile) => <Property label={t("web.issue.detail.profile")}>{profile()}</Property>}</If>
        <If when={sessionBranch(head())}>
          {(branch) => (
            <Property align="start" label={t("web.issue.detail.branch")}>
              <View class="flex-row items-start gap-1">
                <Text class="min-w-0 flex-1 pt-1 font-mono text-xs text-ink select-text">{branch()}</Text>
                <IconButton icon="copy" size={14} label={t("web.base.rich.copy")} onClick={() => copyText(branch())} />
              </View>
            </Property>
          )}
        </If>
        <If when={sessionWorktree(head())}>
          {(worktree) => (
            <Property align="start" label="worktree">
              <View class="flex-row items-start gap-1">
                <Text class="min-w-0 flex-1 pt-1 font-mono text-xs text-ink select-text">{worktree()}</Text>
                <IconButton icon="copy" size={14} label={t("web.issue.detail.copyPath")} onClick={() => copyText(worktree())} />
              </View>
            </Property>
          )}
        </If>
        <Property label={t("web.issue.detail.took")}>
          <Text class="text-sm text-ink tabular-nums">{s().usedLine(steps(), now())}</Text>
        </Property>
        <If when={s().resolvedFindings.length > 0}>
          <Property align="start" label={t("web.issue.detail.resolved")}>
            <View class="pt-0.5">
              <Each of={s().resolvedFindings}>{(f) => <Text class="text-sm text-faint line-through">{f().text}</Text>}</Each>
            </View>
          </Property>
        </If>
      </More>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

/** The issue's title, renamed in place while the issue is open: Return or leaving the field keeps it, Escape lets it go. */
function IssueTitle(props: { shown: string; full: string; editable: boolean; state: "pending" | "failed" | undefined; onSave: (title: string) => void }) {
  const editing = signal(false);
  let typed = "";
  const finish = (keep: boolean) => {
    if (!editing()) return;
    editing.set(false);
    const title = typed.trim();
    if (keep && title !== "" && title !== props.full) props.onSave(title);
  };
  return (
    <If
      when={editing()}
      else={
        <View class="min-w-0 flex-1" style={props.state === "pending" ? { opacity: 0.7 } : undefined}>
          <If
            when={props.editable}
            else={
              <Text role="header" testID="issue-title" class="line-clamp-2 text-lg font-semibold text-ink">
                {props.shown}
              </Text>
            }
          >
            <View
              role="button"
              accessibilityLabel={t("web.issue.detail.rename")}
              tooltip={<Bubble text={t("web.issue.detail.rename")} />}
              onPress={() => {
                typed = props.full;
                editing.set(true);
              }}
              class="-mx-1 self-start rounded-sm px-1 hover:bg-hover"
            >
              <Text role="header" testID="issue-title" class="line-clamp-2 text-lg font-semibold text-ink">
                {props.shown}
              </Text>
            </View>
          </If>
        </View>
      }
    >
      <TitleInput full={props.full} onInput={(v) => (typed = v)} onFinish={finish} />
    </If>
  );
}

function TitleInput(props: { full: string; onInput: (v: string) => void; onFinish: (keep: boolean) => void }) {
  // Bound while the field is up: Escape lets the new title go.
  keymap.bind("escape", () => props.onFinish(false), { when: "always" });
  return (
    <TextInput
      testID="issue-title-input"
      accessibilityLabel={t("web.issue.detail.rename")}
      value={props.full}
      text="lg"
      autoFocus
      class="min-w-0 flex-1"
      onInput={props.onInput}
      onSubmit={() => props.onFinish(true)}
      onBlur={() => props.onFinish(true)}
    />
  );
}
