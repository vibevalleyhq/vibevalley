import { computed, signal, Text, View } from "nsh";
import { Input, Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import {
  type Attachment,
  type Deliverable,
  DeliverableValues,
  type Issue,
  type IssueStatus,
  type IssueUpdate,
  type Priority,
  PriorityValues,
} from "@vibevalley/protocol";
import { assignedAgentOf, omitUndefined } from "@vibevalley/protocol/rules";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { ConfirmButton } from "../../../design/ConfirmButton";
import { TextArea } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { Markdown } from "../../../design/Markdown";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { useWorkAgents } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { ago, shortMomentText } from "../../../infra/base/format";
import { ready, useRepos } from "../../../infra/query";
import { createEffect, createSignal, untrack } from "../../../infra/solid";
import { useIntents } from "../../../infra/state/intent";
import { rememberPick } from "../../../infra/state/prefs";
import { IssueArtifacts } from "../../artifact";
import { useIssues } from "../model/history";
import { isRefined, newIssueTitle } from "../model/issue";
import { issueMove, issueMoveOf, movedIssue, sendMove } from "../model/moves";
import { ActLines } from "./ActLines";
import { IssueAttachments } from "./IssueAttachments";
import { DatePropertyEditor, ParentPicker, SubIssuesSection, TagEditor } from "./IssueMetaControls";
import { IssueThread } from "./IssueThread";
import { AgentFaceOf, PriorityMark, StatusMark } from "./Marks";
import { IssueNumberPill, IssueSheet, More, Note, Pick, Property, SheetLabel, StagePill, Stages } from "./Sheet";
import { criteriaList, NewRepoPopoverBody, TodoCriteriaSection, TodoTitle, toggleCriterionLine } from "./TodoSections";

interface Draft {
  title: string;
  description: string;
  criteria: string;
  repo: string;
  agent: string;
  priority: Priority;
  deliver: Deliverable;
  attachments: readonly Attachment[];
  parent: string;
  tags: readonly string[];
  startAt: number | undefined;
  dueAt: number | undefined;
}

const draftOf = (i: Issue): Draft => ({
  title: i.title,
  description: i.description,
  criteria: i.criteria.join("\n"),
  repo: i.repo ?? "",
  agent: assignedAgentOf(i) ?? "",
  priority: i.priority,
  deliver: i.deliver,
  attachments: i.attachments ?? [],
  parent: i.parent ?? "",
  tags: i.tags ?? [],
  startAt: i.startAt,
  dueAt: i.dueAt,
});

/** Moved to todo: it is either worked already, or waits there for room. */
export const dispatchedNotice = (open: (id: string | undefined) => void) => (got: Issue) => {
  if (got.status === "todo") toast(t("web.issue.todo.queued"));
  else open(got.id);
};

/** An issue not sent yet. Preview-first reading and review, with light click-to-edit controls. */
export function TodoDetail(props: { item: Issue; onDone: (id: string | undefined) => void }) {
  // Until the user edits a field, a draft coming back fills them.
  const [form, setForm] = createSignal({ draft: untrack(() => draftOf(props.item)), edited: false });
  const d = () => form().draft;
  const edited = () => form().edited;
  const act = createAct();
  const moves = useIntents(issueMove);
  const move = computed(() => issueMoveOf(props.item.id, moves.list()));
  const busy = computed(() => act.busy() || move()?.state === "moving");
  const word = signal("");
  const newRepo = signal(false);
  const editingDesc = signal(false);
  const refineOpen = signal(false);
  const agents = useWorkAgents(true);
  const allIssues = useIssues();
  const repoList = useRepos();
  const repos = computed(() => ready(repoList, []).map((p) => p.name));
  const agentOptions = computed(() => agents().map((a) => ({ value: a.id, label: a.runtime ? `${a.name} · ${a.runtime}` : a.name })));
  const repoOptions = computed(() => [...new Set([...repos(), ...(d().repo ? [d().repo] : [])])].map((p) => ({ value: p, label: p })));
  const priorityOptions = computed(() => PriorityValues.map((p) => ({ value: p, label: t(`shared.priority.${p}`) })));
  const deliverOptions = computed(() => DeliverableValues.map((v) => ({ value: v, label: t(`shared.deliverable.${v}`) })));

  // The issue as the server has it now replaces the draft, unless the user has started changing it.
  createEffect(
    () => draftOf(props.item),
    (fresh) => {
      if (!untrack(edited)) setForm({ draft: fresh, edited: false });
    },
    { defer: true },
  );

  const edit = (change: Partial<Draft>) => {
    setForm((cur) => ({ draft: { ...cur.draft, ...change }, edited: true }));
  };
  const addAttachment = (file: Attachment) => {
    setForm((cur) => ({
      draft: { ...cur.draft, attachments: [...cur.draft.attachments.filter((a) => a.id !== file.id), file] },
      edited: true,
    }));
  };
  const removeAttachment = (id: string) => {
    setForm((cur) => ({
      draft: { ...cur.draft, attachments: cur.draft.attachments.filter((a) => a.id !== id) },
      edited: true,
    }));
  };

  const update = (x: Draft): IssueUpdate => ({
    title: x.title,
    description: x.description,
    repo: x.repo,
    agent: x.agent,
    priority: x.priority,
    deliver: x.deliver,
    criteria: criteriaList(x.criteria),
    attachments: x.attachments.map((a) => a.id),
    parent: x.parent,
    tags: [...x.tags],
    ...(x.startAt !== props.item.startAt ? { startAt: x.startAt ?? 0 } : {}),
    ...(x.dueAt !== props.item.dueAt ? { dueAt: x.dueAt ?? 0 } : {}),
  });

  // Saving goes with the act (edit): the server saves the fields before it acts on them. Taken when asked, so a call
  // that waits does not read them later.
  const unsaved = (): IssueUpdate | undefined => {
    if (!edited()) return undefined;
    const x = d();
    rememberPick(x.agent, x.repo);
    return update(x);
  };
  const saved = <T,>(got: T) => {
    setForm((cur) => ({ ...cur, edited: false }));
    return got;
  };

  const liveStatus = computed(() => movedIssue(props.item, moves.list()).status);
  const backlog = () => liveStatus() === "backlog";
  const inProgress = () => liveStatus() === "in_progress";
  const inReview = () => liveStatus() === "in_review";
  const closed = () => liveStatus() === "done" || liveStatus() === "canceled";
  const todoStatuses: readonly IssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"];
  const todoStatusLabel = (status: IssueStatus): string => {
    if (status === "backlog") return t("web.issue.todo.draftStatus");
    if (status === "todo") return t("web.issue.todo.todoStatus");
    return t(`shared.status.${status}`);
  };
  const statusOptions = computed(() =>
    todoStatuses.filter((s) => s === liveStatus() || props.item.moves.includes(s)).map((s) => ({ value: s, label: todoStatusLabel(s) })),
  );
  const drafting = () => props.item.refining;
  const refined = () => isRefined(props.item);
  const questions = () => props.item.questions;
  const queued = () => props.item.queuedAt;
  const canSave = computed(() => !busy() && d().title.trim() !== "");
  const canRefine = computed(() => !busy() && !drafting() && (refined() || word().trim() !== "" || d().title.trim() !== newIssueTitle));
  const startable = computed(() => canSave() && !drafting() && d().agent !== "");
  const said = computed((): [string, string] => {
    const by = drafting();
    return by
      ? [t("web.issue.todo.refining", { who: by.name }), t("web.issue.todo.refiningLine")]
      : questions().length > 0
        ? [t("web.issue.todo.questions", { n: questions().length }), t("web.issue.todo.questionsLine")]
        : refined()
          ? [t("web.issue.todo.drafted"), t("web.issue.todo.draftedLine")]
          : [t("web.issue.todo.what"), t("web.issue.todo.whatLine")];
  });

  const draft = () => {
    const id = props.item.id;
    const raw = untrack(word);
    const text = raw.trim();
    const edit = unsaved();
    if (text !== "") word.set("");
    return act
      .run(async () => {
        saved(await api.issue.refine(omitUndefined({ id, text, edit })));
        return true;
      })
      .then((ok) => {
        if (ok !== true && text !== "" && untrack(word) === "") word.set(raw);
        return ok;
      });
  };
  const start = () => {
    const id = props.item.id;
    const x = d();
    rememberPick(x.agent, x.repo);
    const told = dispatchedNotice(props.onDone);
    // A start the server refused shows on the board's card with why; the same start again is sent with the same key.
    return sendMove(moves, { id, status: "todo", edit: update(x) }).done.then((done) => {
      if (done?.replied) told(saved(done.replied.reply));
    });
  };
  const unqueue = () => {
    const id = props.item.id;
    return sendMove(moves, { id, status: "backlog" }).done;
  };
  const markStatus = (status: IssueStatus) => {
    const id = props.item.id;
    const pendingEdit = status === "done" ? unsaved() : undefined;
    return sendMove(moves, {
      id,
      status,
      lane: status,
      ...(pendingEdit ? { edit: pendingEdit } : {}),
    }).done.then((done) => {
      if (done?.replied && pendingEdit) saved(done.replied.reply);
    });
  };
  const changeStatus = (next: IssueStatus) => {
    if (next === liveStatus()) return;
    if (next === "todo" && liveStatus() === "backlog") {
      if (!d().agent || !d().repo) {
        toast(t("web.issue.page.pickFirst"));
        return;
      }
      void start();
      return;
    }
    void markStatus(next);
  };
  const toggleCriterion = async (index: number) => {
    if (closed() || busy()) return;
    const current = criteria();
    if (index < 0 || index >= current.length) return;
    const nextLines = current.map((line, idx) => (idx === index ? toggleCriterionLine(line) : line));
    const prevRaw = form().draft.criteria;
    const nextRaw = nextLines.join("\n");
    setForm((cur) => ({ ...cur, draft: { ...cur.draft, criteria: nextRaw } }));
    const ok = await act.run(() => api.issue.update({ id: props.item.id, criteria: nextLines }));
    if (ok === undefined) {
      setForm((cur) => (cur.draft.criteria === nextRaw ? { ...cur, draft: { ...cur.draft, criteria: prevRaw } } : cur));
    }
  };
  const remove = () => {
    const id = props.item.id;
    const done = props.onDone;
    return act.run(async () => {
      await api.issue.delete({ id });
      done(undefined);
    });
  };

  const parentIssue = computed(() => (d().parent ? allIssues().find((i) => i.id === d().parent) : undefined));
  const criteria = computed(() => criteriaList(d().criteria));
  const heading = (
    <View>
      <View class="mb-2 flex-row flex-wrap items-center gap-1.5">
        <If when={d().repo}>
          {(repo) => (
            <>
              <View class="flex-row items-center gap-1 rounded-md bg-side px-1.5 py-0.5">
                <Icon name="folder" size={12} tone="muted" />
                <Text class="text-xs font-medium text-muted">{repo()}</Text>
              </View>
              <Icon name="next" size={12} tone="faint" />
            </>
          )}
        </If>
        <If when={d().parent}>
          {(parentId) => (
            <>
              <View
                role="button"
                testID="parent-issue"
                class="flex-row items-center gap-1 rounded-md border border-line bg-side px-1.5 py-0.5 hover:bg-hover"
                onPress={() => props.onDone(parentId())}
              >
                <Text class="text-xs text-water">{parentIssue() ? `#${parentIssue()!.number} ${parentIssue()!.title}` : t("web.issue.family.parent")}</Text>
              </View>
              <Icon name="next" size={12} tone="faint" />
            </>
          )}
        </If>
        <IssueNumberPill number={props.item.number} />
      </View>
      <If
        when={backlog()}
        else={
          <View testID="todo-stage-pill" class="mb-3 flex-row items-center gap-2">
            <StagePill
              tone={inReview() ? "wheat" : inProgress() ? "water" : liveStatus() === "done" ? "leaf" : "muted"}
              label={
                inReview()
                  ? t("shared.stage.reviewing")
                  : inProgress()
                    ? t("shared.status.in_progress")
                    : liveStatus() === "todo"
                      ? t("web.issue.todo.todoStatus")
                      : t(`shared.status.${liveStatus()}`)
              }
            />
          </View>
        }
      >
        <View class="mb-4">
          <Stages at="talk" />
        </View>
      </If>
      <TodoTitle value={d().title} editable={!closed()} onCommit={(title) => edit({ title })} />
    </View>
  );

  // One place to start from: a new draft is one sentence to draft from; its description and criteria come in once drafted,
  // written, or asked for (manual entry).
  const own = signal(false);
  const written = computed(() => refined() || d().description.trim() !== "" || criteria().length > 0);
  const fields = computed(() => written() || own() || !backlog());
  const showTalkInput = computed(() => questions().length > 0 || !written() || refineOpen());
  const talkHighlight = computed<"water" | "wheat" | undefined>(() => (drafting() ? "water" : questions().length > 0 ? "wheat" : undefined));
  const talk = () => (
    <If when={backlog()}>
      <View
        testID="issue-talk-card"
        accessibilityLabel={t("web.issue.todo.talk")}
        class={`mt-5 rounded-xl border px-4 py-3 ${talkHighlight() ? "" : "border-line bg-side"}`}
        style={talkHighlight() ? { borderColor: mix(talkHighlight()!, 0.35), backgroundColor: mix(talkHighlight()!, 0.08) } : undefined}
      >
        <View class="flex-row flex-wrap items-center justify-between gap-3">
          <View class="min-w-0 flex-1">
            <View class="flex-row items-center gap-2">
              <Icon name={drafting() ? "bolt" : "idea"} size={14} tone={talkHighlight() ?? "muted"} />
              <Text class="min-w-0 flex-1 text-sm font-semibold text-ink">{said()[0]}</Text>
            </View>
            <Text class="mt-0.5 text-xs leading-relaxed text-muted">{said()[1]}</Text>
          </View>
          <View class="shrink-0 flex-row flex-wrap items-center gap-2">
            <Button
              tone={written() ? "primary" : "plain"}
              testID="issue-start"
              disabled={!startable()}
              accessibilityLabel={d().agent ? undefined : t("web.issue.todo.pickHelper")}
              onPress={() => void start()}
            >
              {t("web.issue.todo.start")}
            </Button>
            <If when={!showTalkInput()}>
              <Button testID="issue-draft-toggle" tone="quiet" disabled={busy() || Boolean(drafting())} onPress={() => refineOpen.set(true)}>
                {refined() || written() ? t("web.issue.todo.polish") : t("web.issue.todo.draft")}
              </Button>
            </If>
          </View>
        </View>
        <If when={showTalkInput()}>
          <Each of={questions()} key={(a) => a.question}>
            {(a) => (
              <View class="mt-2.5">
                <Text class="text-sm text-ink">{`· ${a().question}`}</Text>
                <If when={a().options.length}>
                  <View class="mt-1.5 flex-row flex-wrap gap-1.5 pl-3" accessibilityLabel={t("web.issue.todo.answerTo", { question: a().question })}>
                    <Each of={a().options} key={(o) => o}>
                      {(o) => (
                        <Button disabled={busy()} onPress={() => word.set(o())}>
                          {o()}
                        </Button>
                      )}
                    </Each>
                  </View>
                </If>
              </View>
            )}
          </Each>
          <TextArea
            testID="issue-talk"
            class="mt-3"
            rows={2}
            value={word()}
            onInput={(v) => word.set(v)}
            submit
            onSubmit={() => canRefine() && void draft()}
            placeholder={questions().length > 0 ? t("web.issue.todo.answerHint") : refined() ? t("web.issue.todo.againHint") : t("web.issue.todo.whatHint")}
            accessibilityLabel={t("web.issue.todo.whatLabel")}
          />
          <View class="mt-3 flex-row flex-wrap items-center gap-2">
            <Button testID="issue-draft" tone={written() ? "plain" : "primary"} disabled={!canRefine()} onPress={() => void draft()}>
              {refined() ? t("web.issue.todo.redraft") : t("web.issue.todo.draft")}
            </Button>
            <If when={refineOpen() && written() && questions().length === 0}>
              <Button testID="issue-draft-cancel" tone="quiet" onPress={() => refineOpen.set(false)}>
                {t("web.issue.never")}
              </Button>
            </If>
          </View>
        </If>
      </View>
    </If>
  );

  const hasDescription = computed(() => d().description.trim() !== "");
  const main = (
    <>
      <If
        when={fields()}
        else={
          <>
            {talk()}
            <View
              role="button"
              testID="issue-write-own"
              onPress={() => {
                own.set(true);
                editingDesc.set(true);
              }}
              class="-mx-1.5 mt-3 self-start rounded-md px-1.5 py-1 hover:bg-hover"
            >
              <Text class="text-sm text-muted">{t("web.issue.todo.writeOwn")}</Text>
            </View>
          </>
        }
      >
        <View>
          <If when={inReview()}>
            <View
              testID="todo-review-banner"
              class="mb-5 flex-row flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3"
              style={{ borderColor: mix("wheat", 0.35), backgroundColor: mix("wheat", 0.08) }}
            >
              <View class="min-w-0 flex-1 flex-row items-center gap-2">
                <Icon name="check" size={15} tone="wheat" />
                <Text class="min-w-0 flex-1 text-sm font-semibold text-ink">{t("shared.stage.reviewing")}</Text>
              </View>
              <Button tone="primary" icon="check" testID="todo-accept" disabled={busy()} onPress={() => void markStatus("done")}>
                {t("web.issue.todo.accept")}
              </Button>
            </View>
          </If>
          <If
            when={editingDesc()}
            else={
              <If
                when={hasDescription()}
                else={
                  <If when={!closed()}>
                    <View role="button" testID="issue-edit-description" onPress={() => editingDesc.set(true)} class="-mx-2 rounded-md px-2 py-2 hover:bg-hover">
                      <Text class="text-sm text-faint">{t("web.issue.todo.addDescription")}</Text>
                    </View>
                  </If>
                }
              >
                <View class="mb-2 flex-row items-center justify-between gap-2">
                  <Text class="text-xs font-semibold text-muted">{t("web.issue.todo.description")}</Text>
                  <If when={!closed()}>
                    <Button size="compact" tone="quiet" icon="edit" testID="issue-edit-description" onPress={() => editingDesc.set(true)}>
                      {t("web.issue.todo.edit")}
                    </Button>
                  </If>
                </View>
                <View testID="issue-description-preview">
                  <Markdown size="sm" text={d().description} />
                </View>
              </If>
            }
          >
            <View class="mb-2 flex-row items-center justify-between gap-2">
              <Text class="text-xs font-semibold text-muted">{t("web.issue.todo.description")}</Text>
              <Button size="compact" tone="quiet" icon="check" testID="issue-edit-description-done" onPress={() => editingDesc.set(false)}>
                {t("web.issue.todo.doneEditing")}
              </Button>
            </View>
            <Input
              multiline
              autoFocus
              testID="issue-description"
              value={d().description}
              onChange={(e) => edit({ description: e.value })}
              placeholder={t("web.issue.todo.descriptionHint")}
              accessibilityLabel={t("web.issue.todo.description")}
              class="min-h-22 w-full rounded-md border border-line bg-page px-2.5 py-2 text-sm text-ink placeholder:text-faint focus:border-focus"
            />
          </If>
        </View>

        <TodoCriteriaSection
          value={d().criteria}
          criteria={criteria()}
          editable={!closed()}
          busy={busy()}
          onInput={(v) => edit({ criteria: v })}
          onToggle={(index) => void toggleCriterion(index)}
        />
        {talk()}
      </If>
      <IssueAttachments files={d().attachments} editable={!closed()} busy={busy()} onAdd={addAttachment} onRemove={removeAttachment} />
      <SubIssuesSection issueId={props.item.id} allIssues={allIssues()} onOpen={(id) => props.onDone(id)} />
      <IssueThread issue={props.item.id} />
      <IssueArtifacts
        issue={props.item.id}
        heading={
          <View class="mt-7 border-t border-line pt-5">
            <SheetLabel first>{t("web.artifact.issue.title")}</SheetLabel>
          </View>
        }
      />
    </>
  );

  const side = (
    <>
      <SheetLabel first>{t("web.issue.detail.properties")}</SheetLabel>
      <Property label={t("web.issue.todo.status")} icon={<StatusMark status={liveStatus()} size={13} />} inset>
        <Pick
          label={t("web.issue.todo.status")}
          testid="todo-status"
          value={liveStatus()}
          disabled={busy() || statusOptions().length <= 1}
          onChange={(v) => changeStatus(v)}
          options={statusOptions()}
        />
      </Property>
      <Property
        label={t("web.issue.detail.helper")}
        icon={
          <If when={d().agent} else={<Icon name="agents" size={13} tone="muted" />}>
            {(agent) => <AgentFaceOf agent={agent()} size={16} />}
          </If>
        }
        inset
      >
        <Pick
          label={t("web.issue.detail.helper")}
          testid="issue-helper"
          value={d().agent}
          placeholder={t("web.issue.todo.pickForMe")}
          onChange={(v) => edit({ agent: v })}
          options={agentOptions()}
        />
      </Property>
      <Property align="start" label={t("web.issue.task.repo")} icon={<Icon name="folder" size={13} tone="muted" />} inset>
        <View class="gap-1">
          <Pick
            label={t("web.issue.task.repo")}
            testid="issue-repo"
            value={d().repo}
            placeholder={t("web.issue.todo.whichRepo")}
            onChange={(v) => edit({ repo: v })}
            options={repoOptions()}
          />
          <Popover
            open={newRepo()}
            onOpenChange={(e) => newRepo.set(e.open)}
            placement="bottom"
            align="start"
            offset={6}
            popupClass="w-64 rounded-lg border border-line bg-elevated p-3 shadow-float"
            trigger={
              <View
                role="button"
                testID="new-repo"
                onPress={() => newRepo.set(true)}
                class="flex-row items-center gap-1 self-start rounded-sm px-2 py-0.5 hover:bg-hover"
              >
                <Icon name="add" size={12} tone="water" />
                <Text class="text-xs text-water">{repos().length === 0 && !d().repo ? t("web.issue.todo.firstRepo") : t("web.issue.todo.newRepoLink")}</Text>
              </View>
            }
          >
            <If when={newRepo()}>
              <NewRepoPopoverBody
                onClose={() => newRepo.set(false)}
                onMade={(name) => {
                  newRepo.set(false);
                  edit({ repo: name });
                }}
              />
            </If>
          </Popover>
        </View>
      </Property>
      <Property label={t("web.issue.todo.priority")} icon={<PriorityMark priority={d().priority} size={13} />} inset>
        <Pick
          label={t("web.issue.todo.priority")}
          testid="issue-priority"
          value={d().priority}
          onChange={(v) => edit({ priority: v })}
          options={priorityOptions()}
        />
      </Property>
      <Property label={t("web.issue.detail.deliver")} icon={<Icon name={d().deliver === "answer" ? "chat" : "diff"} size={13} tone="muted" />} inset>
        <Pick
          label={t("web.issue.detail.deliver")}
          testid="issue-deliver"
          value={d().deliver}
          disabled={closed()}
          onChange={(v) => edit({ deliver: v })}
          options={deliverOptions()}
        />
      </Property>
      <Property label={t("web.issue.family.parent")} icon={<Icon name="indent" size={13} tone="muted" />} inset>
        <ParentPicker issueId={props.item.id} parentId={d().parent} allIssues={allIssues()} disabled={closed()} onChange={(parent) => edit({ parent })} />
      </Property>
      <Property align="start" label={t("web.issue.tags.label")} icon={<Icon name="catalog" size={13} tone="muted" />} inset>
        <TagEditor tags={d().tags} disabled={closed()} onChange={(tags) => edit({ tags })} />
      </Property>
      <SheetLabel divider>{t("web.issue.detail.time")}</SheetLabel>
      <Property label={t("web.issue.dates.startAt")} icon={<Icon name="calendar" size={13} tone="muted" />} inset>
        <DatePropertyEditor
          label={t("web.issue.dates.startAt")}
          value={d().startAt}
          disabled={closed()}
          testid="issue-start-at"
          onCommit={(ms) => edit({ startAt: ms > 0 ? ms : undefined })}
        />
      </Property>
      <Property label={t("web.issue.dates.dueAt")} icon={<Icon name="calendar" size={13} tone="muted" />} inset>
        <DatePropertyEditor
          label={t("web.issue.dates.dueAt")}
          value={d().dueAt}
          disabled={closed()}
          testid="issue-due-at"
          onCommit={(ms) => edit({ dueAt: ms > 0 ? ms : undefined })}
        />
      </Property>
      <More>
        <Property label={t("web.issue.task.written")}>
          <Text class="text-sm text-ink tabular-nums">{shortMomentText(props.item.createdAt)}</Text>
        </Property>
      </More>
      <If when={queued()}>
        {(at) => (
          <Note tone="water" class="mt-3 p-2.5">
            <Text class="text-sm text-ink">{t("web.issue.todo.inQueue", { ago: ago(at(), Date.now()) })}</Text>
            <Button class="mt-2 self-start" testID="issue-unqueue" disabled={busy()} onPress={() => void unqueue()}>
              {t("web.issue.todo.unqueue")}
            </Button>
          </Note>
        )}
      </If>
      <View class="mt-4">
        <ActLines issue={props.item.id} />
      </View>
      <View class="mt-2 gap-2 border-t border-line pt-4">
        <If when={edited()}>
          <View class="flex-row items-center gap-2">
            <View class="h-1.5 w-1.5 shrink-0 rounded-full bg-wheat" />
            <Button
              tone="primary"
              testID="issue-save"
              disabled={!canSave()}
              onPress={() => {
                const id = props.item.id;
                const edit = unsaved();
                if (edit) void act.run(async () => saved(await api.issue.update({ id, ...edit })));
              }}
            >
              {t("web.issue.todo.save")}
            </Button>
          </View>
        </If>
        <If
          when={!closed()}
          else={
            <View class="flex-row flex-wrap items-center gap-2">
              <Button testID="todo-revive" tone="plain" disabled={busy()} onPress={() => void markStatus("backlog")}>
                {t("web.issue.todo.revive")}
              </Button>
              <ConfirmButton testid="issue-remove" tone="danger" label={t("web.issue.todo.remove")} disabled={busy()} onConfirm={remove} />
            </View>
          }
        >
          <View testID="todo-triage-actions" class="flex-row flex-wrap items-center gap-1.5">
            <If when={backlog()}>
              <Button
                size="compact"
                tone="plain"
                testID="todo-mark-ready"
                disabled={!startable()}
                accessibilityLabel={d().agent ? undefined : t("web.issue.todo.pickHelper")}
                onPress={() => void start()}
              >
                {t("web.issue.todo.markReady")}
              </Button>
            </If>
            <If
              when={inReview()}
              else={
                <Button size="compact" tone="plain" icon="check" testID="todo-mark-done" disabled={busy()} onPress={() => void markStatus("done")}>
                  {t("web.issue.todo.markDone")}
                </Button>
              }
            >
              <Button size="compact" tone="primary" icon="check" testID="todo-accept-side" disabled={busy()} onPress={() => void markStatus("done")}>
                {t("web.issue.todo.accept")}
              </Button>
            </If>
            <Button size="compact" tone="danger" testID="todo-mark-canceled" disabled={busy()} onPress={() => void markStatus("canceled")}>
              {t("web.issue.todo.markCanceled")}
            </Button>
          </View>
          <View class="flex-row flex-wrap items-center gap-2 pt-1">
            <ConfirmButton testid="issue-remove" tone="danger" label={t("web.issue.todo.remove")} disabled={busy()} onConfirm={remove} />
          </View>
        </If>
      </View>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}
