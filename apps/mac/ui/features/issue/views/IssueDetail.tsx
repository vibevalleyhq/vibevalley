import { Clipboard, computed, keymap, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

import { list, t } from "@vibevalley/i18n";
import { type Attachment, DeliverableValues, type Issue, type IssueAct, PriorityValues, type Session, type SessionView } from "@vibevalley/protocol";
import { closedText, plainText, sessionProfile } from "@vibevalley/protocol/rules";

import { Button } from "../../../design/Button";
import { OpenTerminal } from "../../../design/domain/OpenTerminal";
import { TextArea } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import type { IconName } from "../../../design/icons";
import { motionClass } from "../../../design/motion";
import { TextLink } from "../../../design/TextLink";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { createAct } from "../../../infra/act";
import { useAgent } from "../../../infra/agents";
import { useNow } from "../../../infra/base/dom";
import { shortMomentText } from "../../../infra/base/format";
import { useTimeout } from "../../../infra/base/timer";
import { hostApi } from "../../../infra/bridge";
import { useBoardSlice } from "../../../infra/frame";
import { useIssueChanges } from "../../../infra/issueActions";
import { ready } from "../../../infra/query";
import { createEffect, createMemo, untrack } from "../../../infra/solid";
import { useIntents } from "../../../infra/state/intent";
import { IssueBodyEditor, IssueNotes, useNotes } from "../../note";
import { SubagentProgress } from "../../session";
import { createIssueActs } from "../model/acts";
import type { Tone } from "../model/cards";
import { changesLine } from "../model/changes";
import { useIssues, useIssueTimeline } from "../model/history";
import { blockerIssuesOf, relationIssuesOf } from "../model/meta";
import { issueMove, movedIssue } from "../model/moves";
import { issueState, stageTone } from "../model/overview";
import { issueSet, labeledIssue, sendLabel, updateIssueAttachments } from "../model/write";
import { ActLines } from "./ActLines";
import { ChangesBody, ChangesHead, ConflictFiles } from "./CloseDialog";
import { IssueActivity } from "./IssueActivity";
import { IssueAttachments } from "./IssueAttachments";
import {
  BlockedByChips,
  BlockedByPicker,
  DatePropertyEditor,
  OwnerMark,
  OwnerPicker,
  ParentPicker,
  RelationChips,
  RelationsPicker,
  SubIssuesSection,
  TagEditor,
} from "./IssueMetaControls";
import { AnswerView, Criteria, DeliveryReceiptCard, OrchestratorIssueDetail, Question } from "./IssueSections";
import { AgentFaceOf, PriorityMark, StatusMark } from "./Marks";
import { Fold, IssueSheet, IssueTrail, More, Note, Pick, Property, SheetLabel, StagePill } from "./Sheet";

export { OrchestratorIssueDetail };

const askIcon: Record<Tone, IconName> = {
  leaf: "check",
  berry: "warn",
  wheat: "warn",
  water: "info",
  muted: "info",
  faint: "info",
};

/** The workbench's issue page, answering the user top to bottom. the side holds the facts. */
export function IssueDetail(props: {
  issue: Issue;
  sessions: Session[];
  session?: SessionView | undefined;
  onClose: (session: Session, review: boolean) => void;
  onOpen?: ((id: string) => void) | undefined;
  onParent?: (() => void) | undefined;
}) {
  const board = useBoardSlice();
  const issues = useIssues();
  const notesQuery = useNotes(() => ({}));
  const allNotes = computed(() => ready(notesQuery, []));
  const now = useNow();
  const moves = useIntents(issueMove);
  const sets = useIntents(issueSet);
  const labeled = createMemo(() => labeledIssue(issues().find((item) => item.id === props.issue.id) ?? props.issue, sets.list()));
  const live = () => labeled().issue;
  const s = createMemo(() => issueState(movedIssue(live(), moves.list()), props.sessions, props.session, issues(), board()?.boardSummary));
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
  const changesQuery = useIssueChanges(
    () => props.issue.id,
    () => s().showsChanges,
  );
  const changes = computed(() => ready(changesQuery, undefined));
  const filesOpen = signal(false);
  const timelineQuery = useIssueTimeline(
    () => props.issue,
    () => head().runs,
  );
  const timeline = computed(() => ready(timelineQuery, undefined));

  /** lead is read as it renders: the lead changes as the issue moves on. */
  const ActButton = (p: { act: IssueAct; lead: boolean }) => (
    <Button
      testID={`act-${p.act}`}
      tone={p.lead ? "primary" : acts.rejecting(p.act) || p.act === "close" ? "danger" : "plain"}
      disabled={acts.disabled(p.act)}
      onPress={() => go(p.act)}
    >
      {acts.label(p.act)}
    </Button>
  );

  const copyText = (value: string) => {
    void Clipboard.writeText(value);
    toast(t("web.base.rich.copied"));
  };

  const openIssue = (id: string) => {
    if (props.onOpen) props.onOpen(id);
    else props.onParent?.();
  };
  const parent = createMemo(() => (live().parent ? issues().find((item) => item.id === live().parent) : undefined));
  const blockers = createMemo(() => blockerIssuesOf(live(), issues()));
  const relations = createMemo(() => relationIssuesOf(live(), issues()));
  const tone = computed(() => stageTone[s().stage.state]);
  const statusParts = computed(() => s().statusParts(now(), timeline()?.spent?.cny));
  const stageMeta = computed(() => statusParts().slice(1).filter(Boolean));
  const heading = (
    <View>
      <IssueTrail parentId={live().parent} parent={parent()} onOpenParent={openIssue} />
      <View class="flex-row flex-wrap items-baseline gap-x-2">
        <IssueTitle shown={s().title} full={live().title} editable={s().open} state={labeled().state("title")} onSave={(title) => setLabel({ title })} />
      </View>
      <View class="mt-2.5 flex-row flex-wrap items-center gap-2" accessibilityLabel={t("web.issue.detail.now")} testID="issue-now">
        <StagePill tone={tone()} label={statusParts()[0] ?? t(`shared.stage.${s().stage.state}`)} />
        <BlockedByChips blockers={blockers()} max={6} onOpen={openIssue} testid="detail-blocked-by" />
        <RelationChips relations={relations()} max={6} onOpen={openIssue} testid="detail-relations" />
        <If when={stageMeta().length > 0}>
          <View class="min-w-0 flex-1 flex-row flex-wrap items-center">
            <Each of={stageMeta()} key="index">
              {(part, i) => <Text class="text-xs text-muted tabular-nums">{`${i() > 0 ? " · " : ""}${part()}`}</Text>}
            </Each>
          </View>
        </If>
      </View>
    </View>
  );

  const placeholder = computed(() =>
    box() === "reject"
      ? t("web.issue.detail.rejectWhere")
      : s().stage.state === "asking"
        ? t("web.issue.detail.sayIt")
        : s().stage.state === "canceled"
          ? t("web.issue.reopen.what")
          : t("web.issue.detail.tell", { who: head().name }),
  );
  const boxLabel = computed(() =>
    box() === "reject"
      ? t("web.issue.detail.rejectLabel")
      : s().stage.state === "asking"
        ? t("web.issue.detail.answer")
        : s().stage.state === "canceled"
          ? t("web.issue.reopen.title")
          : t("web.issue.detail.tell", { who: head().name }),
  );

  const failedCheck = computed(() => {
    const check = live().deliveryEvidence?.check;
    return check?.status === "failed" ? check : undefined;
  });
  const attachAct = createAct();
  const hasAttachmentsSection = computed(() => s().open || (live().attachments?.length ?? 0) > 0);
  const addAttachment = (file: Attachment) => {
    const current = (live().attachments ?? []).map((a) => a.id);
    if (current.includes(file.id)) return;
    return attachAct.run(() => updateIssueAttachments(props.issue.id, [...current, file.id]));
  };
  const removeAttachment = (id: string) => {
    const next = (live().attachments ?? []).filter((a) => a.id !== id).map((a) => a.id);
    return attachAct.run(() => updateIssueAttachments(props.issue.id, next));
  };
  const otherActs = createMemo(() => s().others.filter((a) => a !== "close" && a !== "stop"));
  const hasAboveProgress = computed(
    () => Boolean(s().ask) || Boolean(failedCheck()) || s().description !== "" || Boolean(live().bodyNoteId) || s().open || hasAttachmentsSection(),
  );
  const progressBarPx = computed(() => (s().criteria.length === 0 ? 0 : Math.round((s().met / s().criteria.length) * 96)));
  const main = (
    <>
      <If when={s().ask}>
        {(ask) => (
          <View
            accessibilityLabel={t("web.issue.detail.yours")}
            testID="issue-ask"
            class="mb-6 rounded-xl border px-4 py-3.5"
            style={{ borderColor: mix(ask().tone, 0.35), backgroundColor: mix(ask().tone, 0.08) }}
          >
            <View class="flex-row items-center gap-2">
              <Icon name={askIcon[ask().tone]} size={15} tone={ask().tone === "faint" ? "muted" : ask().tone} />
              <Text class="min-w-0 flex-1 text-sm font-semibold text-ink">{ask().head}</Text>
            </View>
            <If
              when={live().conflict}
              else={<If when={ask().line}>{(line) => <Text class="mt-1.5 line-clamp-4 text-sm leading-relaxed text-ink">{plainText(line())}</Text>}</If>}
            >
              {(conflict) => <ConflictFiles files={conflict().files} worktree={head().cwd} />}
            </If>
            <If when={ask().settingsHref}>
              {(href) => (
                <View class="mt-2">
                  <TextLink href={href()} testid="issue-error-settings">
                    {t("web.issue.error.goSettings")}
                  </TextLink>
                </View>
              )}
            </If>
            <If when={s().stage.state === "asking"}>
              <Each of={props.issue.questions} key={(a) => a.question}>
                {(a) => <Question ask={a()} busy={busy()} onPick={(o) => void doAct("answer", o).then((ok) => ok && setText(""))} />}
              </Each>
            </If>
            <If when={s().stage.state === "asking" || s().stage.state === "canceled" || box()}>
              <TextArea
                testID="issue-words"
                class="mt-3"
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
            <If when={s().lead !== undefined || otherActs().length > 0}>
              <View class="mt-3.5 flex-row flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: mix(ask().tone, 0.18) }}>
                {/* Keyed by the act, as VibeValley's keyed Show: another lead is another button. */}
                <Each of={((l) => (l ? [l] : []))(s().lead)} key={(l) => l}>
                  {(lead) => <ActButton act={lead()} lead />}
                </Each>
                <Each of={otherActs()} key={(a) => a}>
                  {(a) => <ActButton act={a()} lead={false} />}
                </Each>
              </View>
            </If>
          </View>
        )}
      </If>
      <If when={failedCheck()}>
        {(check) => (
          <Note tone="berry" class="mb-5">
            <Fold
              testID="failed-project-check"
              defaultOpen
              bordered={false}
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
      <If when={head().subagents}>{(progress) => <SubagentProgress session={head().id} progress={progress()} now={now()} />}</If>
      <ActLines issue={props.issue.id} words={acts.words()} onSayAgain={acts.sayAgain} onTakeBack={acts.takeBack} />
      <If when={!s().ask && box() === "tell"}>
        <View accessibilityLabel={t("web.issue.detail.tellSection")} class="mb-5 rounded-xl border border-line bg-side p-3.5">
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
          <View class="mt-2.5 flex-row gap-2">
            <ActButton act="tell" lead />
            <Button disabled={busy()} onPress={() => setBox(undefined)}>
              {t("web.issue.never")}
            </Button>
          </View>
        </View>
      </If>
      <If when={s().description !== "" || Boolean(live().bodyNoteId) || s().open}>
        <IssueBodyEditor
          issue={live()}
          editable={s().open}
          notes={allNotes()}
          onOpenIssue={openIssue}
          sectionTitle={t("web.issue.detail.full")}
          emptyLabel={t("web.issue.todo.addDescription")}
          testid="issue-requirement"
        />
      </If>
      <IssueAttachments
        files={live().attachments ?? []}
        editable={s().open}
        busy={attachAct.busy()}
        first={!s().description && !live().bodyNoteId && !s().open}
        onAdd={addAttachment}
        onRemove={removeAttachment}
      />
      <SubIssuesSection issueId={props.issue.id} allIssues={issues()} onOpen={openIssue} />

      <View accessibilityLabel={t("web.issue.detail.progress")} testID="issue-progress" class={hasAboveProgress() ? "mt-7 border-t border-line pt-5" : ""}>
        <View class="mb-2.5 min-h-6 flex-row items-center justify-between gap-2">
          <Text class="text-xs font-semibold text-muted">{t("web.issue.detail.progress")}</Text>
          <If when={s().criteria.length > 0}>
            <View class="flex-row items-center gap-2">
              <Text class="text-xs text-muted tabular-nums">{t("web.issue.detail.met", { met: s().met, of: s().criteria.length })}</Text>
              <View testID="issue-progress-bar" class="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                <View class="h-full rounded-full bg-leaf" style={{ width: progressBarPx() }} />
              </View>
            </View>
          </If>
        </View>
        <If when={s().doing}>
          <Text class="mb-2 text-sm text-water">{s().doing}</Text>
        </If>
        <If when={s().inFamily}>
          <Text class="mb-2 text-xs text-muted">{s().parentText}</Text>
        </If>
        <If
          when={s().criteria.length > 0}
          else={<Text class="text-sm text-muted">{t("web.issue.detail.noCriteria", { answer: live().deliver === "answer" })}</Text>}
        >
          <Criteria rows={s().criteria} checking={s().stage.state === "reviewing" && props.issue.reviewedAt === undefined} />
        </If>
        <If when={s().openFindings.length > 0}>
          <View class="mt-2.5 rounded-lg border border-line bg-bad-soft px-3.5 py-2.5">
            <Text class="text-xs font-medium text-berry">{t("web.issue.detail.rejected")}</Text>
            <Each of={s().openFindings} key="index">
              {(f) => <Text class="mt-0.5 text-sm text-berry">{`· ${f().text}`}</Text>}
            </Each>
          </View>
        </If>
      </View>

      <View accessibilityLabel={t("web.issue.detail.made")} testID="issue-made" class="mt-7 border-t border-line pt-5">
        <SheetLabel first>{t("web.issue.detail.made")}</SheetLabel>
        <If when={live().deliveryReceipt}>{(receipt) => <DeliveryReceiptCard receipt={receipt()} class="mb-2.5" />}</If>
        <If
          when={live().deliver === "answer"}
          else={
            <If
              when={s().showsChanges ? changes() : undefined}
              else={
                <If when={!live().deliveryReceipt}>
                  <View class="flex-row items-center gap-2 rounded-lg border border-line bg-side px-3.5 py-2.5">
                    <Icon name="diff" size={14} tone="faint" />
                    <If
                      when={s().showsChanges}
                      else={
                        <Text class="min-w-0 flex-1 text-xs text-muted">
                          {s().stage.state === "done" ? t("shared.join.sentence", { text: closedText(props.issue) }) : t("web.issue.detail.nothingToSee")}
                        </Text>
                      }
                    >
                      <Text class="min-w-0 flex-1 text-xs text-muted">
                        {changesQuery.status() === "pending" ? t("web.issue.reading") : t("web.issue.detail.changesUnread")}
                      </Text>
                    </If>
                  </View>
                </If>
              }
            >
              {(c) => (
                <If
                  when={c().commits.length > 0 || c().uncommitted.length > 0 || c().files.length > 0}
                  else={
                    <If when={!live().deliveryReceipt}>
                      <View class="flex-row items-center gap-2 rounded-lg border border-line bg-side px-3.5 py-2.5">
                        <Icon name="diff" size={14} tone="faint" />
                        <Text class="min-w-0 flex-1 text-xs text-muted">{t("web.issue.detail.noChanges")}</Text>
                      </View>
                    </If>
                  }
                >
                  <View class="gap-2 rounded-lg border border-line bg-page p-3.5">
                    <Text class="text-sm text-ink tabular-nums">{changesLine(c())}</Text>
                    <If when={c().conflicts.length > 0}>
                      <Text class="text-sm text-berry">{t("web.issue.detail.conflict", { base: c().base, files: list(c().conflicts) })}</Text>
                    </If>
                    <Fold
                      testID="changed-files"
                      bordered={false}
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
          <If
            when={props.issue.answer}
            else={
              <If when={!live().deliveryReceipt}>
                <View class="flex-row items-center gap-2 rounded-lg border border-line bg-side px-3.5 py-2.5">
                  <Icon name="chat" size={14} tone="faint" />
                  <Text class="min-w-0 flex-1 text-xs text-muted">{t("web.issue.detail.noAnswer")}</Text>
                </View>
              </If>
            }
          >
            {(a) => (
              <View class="rounded-lg border border-line bg-page p-3.5">
                <AnswerView answer={a()} />
              </View>
            )}
          </If>
        </If>
        <If when={props.issue.pullRequest}>
          {(pr) => (
            <View
              role="link"
              class="mt-2 flex-row items-center gap-1.5 self-start rounded-md border border-line bg-page px-2.5 py-1 hover:bg-hover"
              onPress={() => void hostApi.openUrl(pr().url)}
            >
              <Icon name="branch" size={12} tone="water" />
              <Text class="text-xs font-medium text-water">{t("shared.join.aside", { text: `PR #${pr().number}`, aside: pr().state })}</Text>
            </View>
          )}
        </If>
      </View>

      <IssueNotes
        issue={props.issue.id}
        heading={
          <View class="mt-7 border-t border-line pt-5">
            <Text class="text-xs font-semibold text-muted">{t("web.note.issue.title")}</Text>
          </View>
        }
      />

      <IssueActivity
        issue={props.issue}
        headSessionId={head().id}
        timeline={timeline()}
        timelinePending={timelineQuery.status() === "pending"}
        runsVersion={`${props.issue.stage.state}:${props.session?.runs}:${props.session?.phase._tag}:${props.issue.findings.length}:${props.issue.closedAt ?? ""}`}
      />
    </>
  );

  // The acts the block above does not offer: a word, a stop, a close.
  const sideActs = createMemo(() => {
    const all = s().stage.acts.map((a) => a.act);
    return s().ask ? all.filter((a) => a === "close" || a === "stop") : all;
  });
  // Destructive close lives in the danger button below: listing it here too would duplicate it.
  const statusMoves = createMemo(() => s().stage.acts.flatMap((a) => (a.does === "move" && a.act !== "close" ? [{ act: a.act, status: a.status }] : [])));
  // Two acts to one status (reject and resume both go back to work) say which act each is.
  const statusOptions = createMemo(() => {
    const moves = statusMoves();
    const options: { value: IssueAct | "now"; label: string }[] = [{ value: "now", label: t(`shared.status.${live().status}`) }];
    for (const m of moves) {
      const status = t(`shared.status.${m.status}`);
      const shared = moves.filter((o) => o.status === m.status).length > 1;
      options.push({ value: m.act, label: shared ? t("shared.join.aside", { text: status, aside: acts.label(m.act) }) : status });
    }
    return options;
  });
  const priorityOptions = computed(() => PriorityValues.map((v) => ({ value: v, label: t(`shared.priority.${v}`) })));
  const deliverOptions = computed(() => DeliverableValues.map((v) => ({ value: v, label: t(`shared.deliverable.${v}`) })));
  const distinctProfile = computed(() => {
    const name = agent()?.name;
    return name && name !== head().name ? name : undefined;
  });
  const side = (
    <>
      <SheetLabel first>{t("web.issue.detail.properties")}</SheetLabel>
      <Property label={t("web.issue.detail.status")} icon={<StatusMark status={live().status} size={13} />} inset>
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
      <Property label={t("web.issue.detail.priority")} icon={<PriorityMark priority={live().priority} size={13} />} inset>
        <Pick
          label={t("web.issue.detail.priority")}
          testid="issue-priority"
          value={live().priority}
          state={labeled().state("priority")}
          disabled={!s().open}
          onChange={(priority) => setLabel({ priority })}
          options={priorityOptions()}
        />
      </Property>
      <If when={!s().inFamily}>
        <Property label={t("web.issue.detail.deliver")} icon={<Icon name={live().deliver === "answer" ? "chat" : "diff"} size={13} tone="muted" />} inset>
          <Pick
            label={t("web.issue.detail.deliver")}
            testid="issue-deliver"
            value={live().deliver}
            state={labeled().state("deliver")}
            disabled={busy() || !s().open}
            onChange={(deliver) => setLabel({ deliver })}
            options={deliverOptions()}
          />
        </Property>
      </If>
      <Property label={t("web.issue.detail.repo")} icon={<Icon name="folder" size={13} tone="muted" />}>
        {s().repo || t("web.issue.detail.noRepo")}
      </Property>
      <Property
        label={t("web.issue.detail.helper")}
        icon={
          <If when={sessionProfile(head())} else={<Icon name="agents" size={13} tone="muted" />}>
            {(profile) => <AgentFaceOf agent={profile()} runtime={head().runtime} size={16} />}
          </If>
        }
      >
        {s().whoLine}
      </Property>
      <Property label={t("web.issue.owner.label")} icon={<OwnerMark owner={live().owner} size={15} />} inset>
        <OwnerPicker
          owner={live().owner}
          allIssues={issues()}
          disabled={busy() || !s().open}
          state={labeled().state("owner")}
          testid="issue-owner"
          onChange={(owner) => setLabel({ owner: owner ?? { kind: "user", id: "" } })}
        />
      </Property>
      <If when={agent()?.model}>
        {(model) => (
          <Property label={t("web.issue.detail.model")} icon={<Icon name="bolt" size={13} tone="muted" />}>
            {model()}
          </Property>
        )}
      </If>
      <Property label={t("web.issue.family.parent")} icon={<Icon name="indent" size={13} tone="muted" />} inset>
        <ParentPicker
          issueId={props.issue.id}
          parentId={live().parent ?? ""}
          allIssues={issues()}
          disabled={busy() || !s().open}
          state={labeled().state("parent")}
          onChange={(parent) => setLabel({ parent })}
        />
      </Property>
      <Property align="start" label={t("web.issue.deps.blockedBy")} icon={<Icon name="lock" size={13} tone="muted" />} inset>
        <BlockedByPicker
          issueId={props.issue.id}
          blockedBy={live().blockedBy}
          allIssues={issues()}
          disabled={busy() || !s().open}
          state={labeled().state("blockedBy")}
          onOpen={openIssue}
          onChange={(blockedBy) => setLabel({ blockedBy })}
        />
      </Property>
      <Property align="start" label={t("web.issue.relations.title")} icon={<Icon name="branch" size={13} tone="muted" />} inset>
        <RelationsPicker
          issueId={props.issue.id}
          relations={live().relations ?? []}
          allIssues={issues()}
          disabled={busy() || !s().open}
          state={labeled().state("relations")}
          onOpen={openIssue}
          onChange={(relations) => setLabel({ relations })}
        />
      </Property>
      <Property align="start" label={t("web.issue.tags.label")} icon={<Icon name="catalog" size={13} tone="muted" />} inset>
        <TagEditor tags={live().tags ?? []} disabled={busy() || !s().open} onChange={(tags) => setLabel({ tags })} />
      </Property>
      <SheetLabel divider>{t("web.issue.detail.time")}</SheetLabel>
      <Property label={t("web.issue.dates.startAt")} icon={<Icon name="calendar" size={13} tone="muted" />} inset>
        <DatePropertyEditor
          label={t("web.issue.dates.startAt")}
          value={live().startAt}
          disabled={busy() || !s().open}
          testid="issue-start-at"
          maxMs={live().dueAt}
          onCommit={(startAt) => setLabel({ startAt })}
        />
      </Property>
      <Property label={t("web.issue.dates.dueAt")} icon={<Icon name="calendar" size={13} tone="muted" />} inset>
        <DatePropertyEditor
          label={t("web.issue.dates.dueAt")}
          value={live().dueAt}
          disabled={busy() || !s().open}
          testid="issue-due-at"
          minMs={live().startAt}
          onCommit={(dueAt) => setLabel({ dueAt })}
        />
      </Property>
      <Property label={t("web.issue.detail.opened")} icon={<Icon name="clock" size={13} tone="muted" />}>
        <Text class="text-sm text-ink tabular-nums">{shortMomentText(props.issue.createdAt, now())}</Text>
      </Property>
      <Property label={t("web.issue.detail.started")} icon={<Icon name="play" size={13} tone="muted" />}>
        <Text class="text-sm text-ink tabular-nums">{shortMomentText((props.sessions[0] ?? head()).hiredAt, now())}</Text>
      </Property>
      <If when={s().ask && s().stage.since}>
        {(at) => (
          <Property label={t("web.issue.detail.waiting")} icon={<Icon name="wait" size={13} tone="muted" />}>
            <Text class="text-sm text-ink tabular-nums">{t("web.issue.detail.since", { clock: shortMomentText(at(), now()) })}</Text>
          </Property>
        )}
      </If>
      <If when={live().deliveryEvidence?.reviews.at(-1)}>
        {(review) => (
          <Property label={t("web.issue.changes.reviewVersion")} icon={<Icon name="diff" size={13} tone="muted" />}>
            <Text class="font-mono text-xs text-ink">{`${review().revision.baseCommit.slice(0, 8)} → ${review().revision.tree.slice(0, 12)}`}</Text>
          </Property>
        )}
      </If>
      <If when={!failedCheck() ? live().deliveryEvidence?.check : undefined}>
        {(check) => (
          <Property label={t("web.issue.changes.projectCheck")} icon={<Icon name="check" size={13} tone="muted" />}>
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
          <Property label={t("web.issue.changes.mergedCommit")} icon={<Icon name="branch" size={13} tone="muted" />}>
            <Text class="font-mono text-xs text-ink">{commit().slice(0, 12)}</Text>
          </Property>
        )}
      </If>
      <If when={props.issue.reviewedAt}>
        {(at) => (
          <Property label={t("web.issue.detail.reviewed")} icon={<Icon name="check" size={13} tone="accent" />}>
            <Text class="text-sm text-accent tabular-nums">{shortMomentText(at(), now())}</Text>
          </Property>
        )}
      </If>
      <If when={props.issue.closedAt}>
        {(at) => (
          <Property label={t("web.issue.detail.closedAt")} icon={<Icon name="clock" size={13} tone="muted" />}>
            <Text class="text-sm text-ink tabular-nums">{shortMomentText(at(), now())}</Text>
          </Property>
        )}
      </If>
      <More>
        <If when={s().crewLine}>
          <Property label={t("web.issue.detail.crew")}>{s().crewLine}</Property>
        </If>
        <If when={distinctProfile()}>{(profile) => <Property label={t("web.issue.detail.profile")}>{profile()}</Property>}</If>
        <If when={head().cwd}>
          {(cwd) => (
            <Property align="start" label={t("web.issue.detail.cwd")}>
              <View class="flex-row items-start gap-1">
                <Text class="min-w-0 flex-1 pt-1 font-mono text-xs text-ink select-text">{cwd()}</Text>
                <IconButton icon="copy" size={14} label={t("web.issue.detail.copyPath")} onClick={() => copyText(cwd())} />
              </View>
            </Property>
          )}
        </If>
        <Property label={t("web.issue.detail.took")}>
          <Text class="text-sm text-ink tabular-nums">{s().usedLine([], now())}</Text>
        </Property>
        <If when={s().resolvedFindings.length > 0}>
          <Property align="start" label={t("web.issue.detail.resolved")}>
            <View class="pt-0.5">
              <Each of={s().resolvedFindings} key="index">
                {(f) => <Text class="text-sm text-faint line-through">{f().text}</Text>}
              </Each>
            </View>
          </Property>
        </If>
      </More>
      <If when={sideActs().length > 0 || head().cwd}>
        <View testID="issue-side-actions" class="mt-4 flex-row flex-wrap items-center gap-2 border-t border-line pt-4">
          <Each of={sideActs()} key={(a) => a}>
            {(a) => <ActButton act={a()} lead={!s().ask && a() === s().lead} />}
          </Each>
          <If when={head().cwd}>{(cwd) => <OpenTerminal cwd={cwd()} title={`#${props.issue.number}`} testid="issue-open-workspace" />}</If>
        </View>
      </If>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

/** The issue's title, renamed in place while the issue is open with isomorphic view/edit box model (0px jump). */
function IssueTitle(props: { shown: string; full: string; editable: boolean; state: "pending" | "failed" | undefined; onSave: (title: string) => void }) {
  const editing = signal(false);
  const savedBadge = signal(false);
  const clearSaved = useTimeout();
  let wasPending = false;
  createEffect(
    () => props.state,
    (next) => {
      if (next === "pending") {
        wasPending = true;
        savedBadge.set(false);
      } else if (wasPending && next === undefined) {
        wasPending = false;
        savedBadge.set(true);
        clearSaved(() => savedBadge.set(false), 1800);
      } else if (next === "failed") {
        wasPending = false;
      }
    },
    { defer: true },
  );
  let typed = "";
  const finish = (keep: boolean) => {
    if (!editing()) return;
    editing.set(false);
    const title = typed.replace(/[\r\n]+/gu, " ").trim();
    if (keep && title !== "" && title !== props.full) props.onSave(title);
  };
  return (
    <View class="min-w-0 flex-1">
      <If
        when={editing()}
        else={
          <View style={props.state === "pending" ? { opacity: 0.72 } : undefined}>
            <If
              when={props.editable}
              else={
                <View class="-mx-2 w-full rounded-md border border-transparent px-2 py-1">
                  <Text role="header" testID="issue-title" class="text-2xl leading-snug font-semibold text-ink">
                    {props.shown}
                  </Text>
                </View>
              }
            >
              <View
                role="button"
                testID="issue-title-trigger"
                accessibilityLabel={t("web.issue.detail.rename")}
                tooltip={<Bubble text={t("web.issue.detail.rename")} />}
                onPress={() => {
                  typed = props.full;
                  editing.set(true);
                }}
                class="-mx-2 w-full rounded-md border border-transparent px-2 py-1 hover:border-line hover:bg-hover"
              >
                <Text role="header" testID="issue-title" class="text-2xl leading-snug font-semibold text-ink">
                  {props.shown}
                </Text>
              </View>
            </If>
          </View>
        }
      >
        <TitleInput full={props.full} onInput={(v) => (typed = v)} onFinish={finish} />
      </If>
      <View testID="issue-title-save-status" class="mt-1 h-4 flex-row items-center gap-1">
        <If when={props.state === "pending" || savedBadge()}>
          <If
            when={props.state === "pending"}
            else={
              <>
                <Icon name="check" size={11} tone="leaf" />
                <Text class="text-2xs text-leaf">{t("web.agent.saved")}</Text>
              </>
            }
          >
            <View class={motionClass("animate-spin")}>
              <Icon name="wait" size={11} tone="muted" />
            </View>
            <Text class="text-2xs text-muted">{t("web.agent.saving")}</Text>
          </If>
        </If>
      </View>
    </View>
  );
}

function TitleInput(props: { full: string; onInput: (v: string) => void; onFinish: (keep: boolean) => void }) {
  const draft = signal(untrack(() => props.full));
  // Bound while the field is up: Escape lets the new title go.
  keymap.bind("escape", () => props.onFinish(false), { when: "always" });
  return (
    <Input
      multiline
      submitBehavior="submit"
      testID="issue-title-input"
      accessibilityLabel={t("web.issue.detail.rename")}
      value={draft()}
      autoFocus
      class="-mx-2 w-full rounded-md border border-focus bg-page px-2 py-1 text-2xl leading-snug font-semibold text-ink placeholder:text-faint"
      onChange={(e) => {
        const clean = e.value.replace(/[\r\n]+/gu, " ");
        draft.set(clean);
        props.onInput(clean);
      }}
      onSubmit={() => props.onFinish(true)}
      onBlur={() => props.onFinish(true)}
    />
  );
}
