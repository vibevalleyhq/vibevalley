import { computed, signal, Text, View } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import {
  type ActorRef,
  type Attachment,
  type Deliverable,
  DeliverableValues,
  type Issue,
  type IssueRelation,
  type IssueStatus,
  type IssueUpdate,
  type Priority,
  PriorityValues,
} from "@vibevalley/protocol";
import { assignedAgentOf, omitUndefined } from "@vibevalley/protocol/rules";
import { IssueLane as IssueLaneSchema } from "@vibevalley/protocol/schema";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { ConfirmButton } from "../../../design/ConfirmButton";
import { AgentReadinessNote, AgentSelect } from "../../../design/domain/AgentSelect";
import { TextArea } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { useManagedWorkAgents, useWorkAgentReadiness } from "../../../infra/agents";
import { api, reasonOf } from "../../../infra/api";
import { ago, shortMomentText } from "../../../infra/base/format";
import { hostApi } from "../../../infra/bridge";
import { ready, useQueryClient, useRepos } from "../../../infra/query";
import { createEffect, createSignal, untrack } from "../../../infra/solid";
import { useIntents } from "../../../infra/state/intent";
import { rememberPick } from "../../../infra/state/prefs";
import { IssueBodyEditor, IssueNotes, useNotes } from "../../note";
import { todoStatusLabel } from "../model/cards";
import { useIssues } from "../model/history";
import { isRefined, newIssueTitle } from "../model/issue";
import { blockerIssuesOf, relationIssuesOf } from "../model/meta";
import { issueMove, issueMoveOf, movedIssue, sendMove } from "../model/moves";
import { ActLines } from "./ActLines";
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
import { AgentFaceOf, PriorityMark, StatusMark } from "./Marks";
import { IssueSheet, IssueTrail, More, Note, Pick, Property, SheetLabel } from "./Sheet";
import { criteriaList, NewRepoPopoverBody, TodoCriteriaSection, TodoTitle, toggleCriterionLine } from "./TodoSections";

interface Draft {
  title: string;
  description: string;
  criteria: string;
  repo: string;
  agent: string;
  owner: ActorRef | undefined;
  priority: Priority;
  deliver: Deliverable;
  attachments: readonly Attachment[];
  parent: string;
  blockedBy: readonly string[];
  relations: readonly IssueRelation[];
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
  owner: i.owner,
  priority: i.priority,
  deliver: i.deliver,
  attachments: i.attachments ?? [],
  parent: i.parent ?? "",
  blockedBy: [...i.blockedBy],
  relations: [...(i.relations ?? [])],
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
  const repoActions = signal(false);
  const repoActionCreate = signal(false);
  const refineOpen = signal(false);
  const agents = useManagedWorkAgents(true);
  const agentReadiness = useWorkAgentReadiness(true);
  const allIssues = useIssues();
  const notesQuery = useNotes(() => ({}));
  const allNotes = computed(() => ready(notesQuery, []));
  const queries = useQueryClient();
  const repoList = useRepos();
  const repos = computed(() => ready(repoList, []).map((p) => p.name));
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

  const sameOwner = (a: ActorRef | undefined, b: ActorRef | undefined) => a?.kind === b?.kind && a?.id === b?.id;
  const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const sameRelations = (a: readonly IssueRelation[], b: readonly IssueRelation[] | undefined) => {
    const rhs = b ?? [];
    return a.length === rhs.length && a.every((v, i) => v.kind === rhs[i]?.kind && v.issue === rhs[i]?.issue);
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
    ...(!sameIds(x.blockedBy, props.item.blockedBy) ? { blockedBy: [...x.blockedBy] } : {}),
    ...(!sameRelations(x.relations, props.item.relations) ? { relations: [...x.relations] } : {}),
    ...(x.startAt !== props.item.startAt ? { startAt: x.startAt ?? 0 } : {}),
    ...(x.dueAt !== props.item.dueAt ? { dueAt: x.dueAt ?? 0 } : {}),
    ...(!sameOwner(x.owner, props.item.owner) ? { owner: x.owner ?? { kind: "user", id: "" } } : {}),
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
  const closed = () => liveStatus() === "done" || liveStatus() === "canceled";
  const statusOptions = computed(() =>
    IssueLaneSchema.options.filter((s) => s === liveStatus() || props.item.moves.includes(s)).map((s) => ({ value: s, label: todoStatusLabel(s) })),
  );
  const drafting = () => props.item.refining;
  const refined = () => isRefined(props.item);
  const questions = () => props.item.questions;
  const queued = () => props.item.queuedAt;
  const canSave = computed(() => !busy() && d().title.trim() !== "");
  const canRefine = computed(() => !busy() && !drafting() && (refined() || word().trim() !== "" || d().title.trim() !== newIssueTitle));
  const startable = computed(() => canSave() && !drafting() && d().agent !== "");

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

  const mountLocalRepo = async () => {
    const picked = await hostApi.pickFolder();
    if (picked.bizCode !== 0 || !picked.data) return;
    const folder = picked.data;
    try {
      const mounted = await api.repo.mount({ path: folder.path, ...(folder.git ? {} : { initGit: true }) });
      await queries.invalidate({ prefix: ["repos"] });
      edit({ repo: mounted.name });
    } catch (e) {
      toast(reasonOf(e));
    }
  };

  const parentIssue = computed(() => (d().parent ? allIssues().find((i) => i.id === d().parent) : undefined));
  const blockers = computed(() => blockerIssuesOf({ blockedBy: [...d().blockedBy] }, allIssues()));
  const relations = computed(() => relationIssuesOf({ relations: [...d().relations] }, allIssues()));
  const criteria = computed(() => criteriaList(d().criteria));
  const heading = (
    <View>
      <IssueTrail parentId={d().parent || undefined} parent={parentIssue()} onOpenParent={(id) => props.onDone(id)} />
      <TodoTitle value={d().title} editable={!closed()} onCommit={(title) => edit({ title })} />
      <If when={blockers().length > 0 || relations().length > 0}>
        <View class="mt-2 flex-row flex-wrap items-center gap-1.5">
          <BlockedByChips blockers={blockers()} max={6} onOpen={(id) => props.onDone(id)} testid="detail-blocked-by" />
          <RelationChips relations={relations()} max={6} onOpen={(id) => props.onDone(id)} testid="detail-relations" />
        </View>
      </If>
    </View>
  );

  // Only show the inline refine prompt while an agent is refining, asking clarifying questions, or when user opens it.
  const showTalkBox = computed(() => backlog() && (Boolean(drafting()) || questions().length > 0 || refineOpen()));
  const talkStatus = computed<readonly [string, string] | undefined>(() => {
    const by = drafting();
    if (by) return [t("web.issue.todo.refining", { who: by.name }), t("web.issue.todo.refiningLine")];
    if (questions().length > 0) return [t("web.issue.todo.questions", { n: questions().length }), t("web.issue.todo.questionsLine")];
    return undefined;
  });
  const talkHighlight = computed<"water" | "wheat" | undefined>(() => (drafting() ? "water" : questions().length > 0 ? "wheat" : undefined));
  const talk = () => (
    <If when={showTalkBox()}>
      <View
        testID="issue-talk-card"
        accessibilityLabel={t("web.issue.todo.talk")}
        class={`mt-5 rounded-xl border px-4 py-3 ${talkHighlight() ? "" : "border-line bg-side"}`}
        style={talkHighlight() ? { borderColor: mix(talkHighlight()!, 0.35), backgroundColor: mix(talkHighlight()!, 0.08) } : undefined}
      >
        <If when={talkStatus()}>
          {(status) => (
            <View class="mb-2">
              <View class="flex-row items-center gap-2">
                <Icon name={drafting() ? "bolt" : "idea"} size={14} tone={talkHighlight() ?? "muted"} />
                <Text class="min-w-0 flex-1 text-sm font-semibold text-ink">{status()[0]}</Text>
              </View>
              <Text class="mt-0.5 text-xs leading-relaxed text-muted">{status()[1]}</Text>
            </View>
          )}
        </If>
        <Each of={questions()} key={(a) => a.question}>
          {(a) => (
            <View class="mt-2">
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
          class={talkStatus() || questions().length > 0 ? "mt-3" : ""}
          rows={2}
          value={word()}
          onInput={(v) => word.set(v)}
          submit
          onSubmit={() => canRefine() && void draft()}
          placeholder={questions().length > 0 ? t("web.issue.todo.answerHint") : refined() ? t("web.issue.todo.againHint") : t("web.issue.todo.whatHint")}
          accessibilityLabel={t("web.issue.todo.whatLabel")}
        />
        <View class="mt-3 flex-row flex-wrap items-center gap-2">
          <Button testID="issue-draft" tone="primary" disabled={!canRefine()} onPress={() => void draft()}>
            {refined() ? t("web.issue.todo.redraft") : t("web.issue.todo.draft")}
          </Button>
          <If when={refineOpen() && questions().length === 0}>
            <Button testID="issue-draft-cancel" tone="quiet" onPress={() => refineOpen.set(false)}>
              {t("web.issue.never")}
            </Button>
          </If>
        </View>
      </View>
    </If>
  );

  const hasDescription = computed(() => d().description.trim() !== "" || Boolean(props.item.bodyNoteId));
  const main = (
    <>
      <IssueBodyEditor
        issue={props.item}
        editable={!closed()}
        description={d().description}
        notes={allNotes()}
        onDraftDescription={(description) => edit({ description })}
        onOpenIssue={(id) => props.onDone(id)}
        sectionTitle={t("web.issue.todo.description")}
        emptyLabel={t("web.issue.todo.addDescription")}
        placeholder={t("web.issue.todo.descriptionHint")}
      />

      <TodoCriteriaSection
        value={d().criteria}
        criteria={criteria()}
        editable={!closed()}
        busy={busy()}
        onInput={(v) => edit({ criteria: v })}
        onToggle={(index) => void toggleCriterion(index)}
      />
      {talk()}
      <IssueAttachments files={d().attachments} editable={!closed()} busy={busy()} onAdd={addAttachment} onRemove={removeAttachment} />
      <SubIssuesSection issueId={props.item.id} allIssues={allIssues()} onOpen={(id) => props.onDone(id)} />
      <IssueNotes
        issue={props.item.id}
        heading={
          <View class="mt-7 border-t border-line pt-5">
            <SheetLabel first>{t("web.note.issue.title")}</SheetLabel>
          </View>
        }
      />
      <IssueActivity
        issue={props.item}
        runsVersion={`${props.item.stage.state}:${props.item.refining?.session ?? ""}:${props.item.findings.length}:${props.item.closedAt ?? ""}`}
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
        align="start"
        label={t("web.issue.detail.helper")}
        icon={
          <If when={d().agent} else={<Icon name="agents" size={13} tone="muted" />}>
            {(agent) => <AgentFaceOf agent={agent()} size={16} />}
          </If>
        }
        inset
      >
        <View class="gap-1.5">
          <AgentSelect
            quiet
            size="control"
            label={t("web.issue.detail.helper")}
            testid="issue-helper"
            value={d().agent}
            disabled={closed()}
            agents={agents()}
            readiness={agentReadiness}
            placeholder={t("web.issue.todo.pickForMe")}
            onChange={(v) => edit({ agent: v })}
          />
          <If when={d().agent !== ""}>
            <AgentReadinessNote agentId={d().agent} readiness={agentReadiness} testid="issue-helper-status" />
          </If>
        </View>
      </Property>
      <Property label={t("web.issue.owner.label")} icon={<OwnerMark owner={d().owner} size={15} />} inset>
        <OwnerPicker owner={d().owner} allIssues={allIssues()} disabled={closed()} testid="issue-owner" onChange={(owner) => edit({ owner })} />
      </Property>
      <Property align="start" label={t("web.issue.task.repo")} icon={<Icon name="folder" size={13} tone="muted" />} inset>
        <View class="gap-1">
          <View class="flex-row items-center gap-1">
            <View class="min-w-0 flex-1">
              <Pick
                label={t("web.issue.task.repo")}
                testid="issue-repo"
                value={d().repo}
                placeholder={t("web.issue.todo.whichRepo")}
                onChange={(v) => edit({ repo: v })}
                options={repoOptions()}
              />
            </View>
            <If when={!closed() && d().repo !== ""}>
              <Popover
                open={repoActions()}
                onOpenChange={(e) => {
                  repoActions.set(e.open);
                  if (!e.open) repoActionCreate.set(false);
                }}
                placement="bottom"
                align="end"
                offset={6}
                popupClass="w-60 rounded-lg border border-line bg-elevated p-2 shadow-float"
                trigger={
                  <View
                    role="button"
                    testID="repo-actions"
                    accessibilityLabel={t("web.issue.todo.repoActions")}
                    tooltip={<Bubble text={t("web.issue.todo.repoActions")} />}
                    onPress={() => {
                      repoActionCreate.set(false);
                      repoActions.set(true);
                    }}
                    class="size-6 shrink-0 items-center justify-center rounded-sm hover:bg-hover"
                  >
                    <Icon name="add" size={12} tone="muted" />
                  </View>
                }
              >
                <If
                  when={repoActionCreate()}
                  else={
                    <View class="gap-0.5">
                      <View
                        role="button"
                        testID="new-repo"
                        onPress={() => repoActionCreate.set(true)}
                        class="flex-row items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
                      >
                        <Icon name="add" size={12} tone="water" />
                        <Text class="text-xs text-ink">{t("web.issue.todo.newRepoLink")}</Text>
                      </View>
                      <View
                        role="button"
                        testID="mount-local-repo"
                        onPress={() => {
                          repoActions.set(false);
                          void mountLocalRepo();
                        }}
                        class="flex-row items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
                      >
                        <Icon name="folder" size={12} tone="water" />
                        <Text class="text-xs text-ink">{t("web.issue.todo.mountLocalLink")}</Text>
                      </View>
                    </View>
                  }
                >
                  <NewRepoPopoverBody
                    onClose={() => {
                      repoActionCreate.set(false);
                      repoActions.set(false);
                    }}
                    onMade={(name) => {
                      repoActionCreate.set(false);
                      repoActions.set(false);
                      edit({ repo: name });
                    }}
                  />
                </If>
              </Popover>
            </If>
          </View>
          <If when={!closed() && d().repo === ""}>
            <View class="flex-row flex-wrap items-center gap-1">
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
                    <Text class="text-xs text-water">
                      {repos().length === 0 && !d().repo ? t("web.issue.todo.firstRepo") : t("web.issue.todo.newRepoLink")}
                    </Text>
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
              <View
                role="button"
                testID="mount-local-repo"
                onPress={() => void mountLocalRepo()}
                class="flex-row items-center gap-1 self-start rounded-sm px-2 py-0.5 hover:bg-hover"
              >
                <Icon name="folder" size={12} tone="water" />
                <Text class="text-xs text-water">{t("web.issue.todo.mountLocalLink")}</Text>
              </View>
            </View>
          </If>
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
      <Property align="start" label={t("web.issue.deps.blockedBy")} icon={<Icon name="lock" size={13} tone="muted" />} inset>
        <BlockedByPicker
          issueId={props.item.id}
          blockedBy={d().blockedBy}
          allIssues={allIssues()}
          disabled={closed()}
          onOpen={(id) => props.onDone(id)}
          onChange={(blockedBy) => edit({ blockedBy })}
        />
      </Property>
      <Property align="start" label={t("web.issue.relations.title")} icon={<Icon name="branch" size={13} tone="muted" />} inset>
        <RelationsPicker
          issueId={props.item.id}
          relations={d().relations}
          allIssues={allIssues()}
          disabled={closed()}
          onOpen={(id) => props.onDone(id)}
          onChange={(relations) => edit({ relations })}
        />
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
          maxMs={d().dueAt}
          onCommit={(ms) => edit({ startAt: ms > 0 ? ms : undefined })}
        />
      </Property>
      <Property label={t("web.issue.dates.dueAt")} icon={<Icon name="calendar" size={13} tone="muted" />} inset>
        <DatePropertyEditor
          label={t("web.issue.dates.dueAt")}
          value={d().dueAt}
          disabled={closed()}
          testid="issue-due-at"
          minMs={d().startAt}
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
          <View testID="todo-triage-actions" class="flex-row flex-wrap items-center gap-2">
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
              <If when={!showTalkBox()}>
                <Button size="compact" tone="quiet" testID="issue-draft-toggle" disabled={busy() || Boolean(drafting())} onPress={() => refineOpen.set(true)}>
                  {refined() || hasDescription() || criteria().length > 0 ? t("web.issue.todo.polish") : t("web.issue.todo.draft")}
                </Button>
              </If>
            </If>
            <ConfirmButton testid="issue-remove" tone="danger" label={t("web.issue.todo.remove")} disabled={busy()} onConfirm={remove} />
          </View>
        </If>
      </View>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}
