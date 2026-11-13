// Ported from VibeValley apps/web/src/features/issue/views/TodoDetail.tsx:
// the draft and todo page, its talk box, fields and side, and the new repo
// dialog.
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Deliverable, DeliverableValues, type Issue, type IssueUpdate, type Priority, PriorityValues } from "@vibevalley/protocol";
import { assignedAgentOf, omitUndefined } from "@vibevalley/protocol/rules";

import { createEffect, createSignal, untrack } from "../../../../solid";
import { ago, wallClockText } from "../../../base/format";
import { useWorkAgents } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { ready, useQueryClient, useRepos } from "../../../infra/query";
import { useIntents } from "../../../state/intent";
import { rememberPick } from "../../../state/prefs";
import { createAct } from "../../../ui/act";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { TextArea, TextInput } from "../../../ui/Field";
import { toast } from "../../../ui/toasts";
import { IssueArtifacts } from "../../artifact";
import { isRefined, newIssueTitle } from "../model/issue";
import { issueMove, issueMoveOf, sendMove } from "../model/moves";
import { ActLines } from "./ActLines";
import { IssueThread } from "./IssueThread";
import { Fold, IssueSheet, More, Note, Pick, Property, SheetLabel, Stages } from "./Sheet";

interface Draft {
  title: string;
  description: string;
  criteria: string;
  repo: string;
  agent: string;
  priority: Priority;
  deliver: Deliverable;
}

const draftOf = (i: Issue): Draft => ({
  title: i.title,
  description: i.description,
  criteria: i.criteria.join("\n"),
  repo: i.repo ?? "",
  agent: assignedAgentOf(i) ?? "",
  priority: i.priority,
  deliver: i.deliver,
});

const criteriaList = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Moved to todo: it is either worked already, or waits there for room. */
export const dispatchedNotice = (open: (id: string | undefined) => void) => (got: Issue) => {
  if (got.status === "todo") toast(t("web.issue.todo.queued"));
  else open(got.id);
};

// The bare fields of the sheet: no box until the pointer or the focus is on them.
const bare = "w-full rounded-md border border-transparent bg-transparent text-ink placeholder:text-faint hover:border-line focus:border-focus";

/** An issue not sent yet. In the backlog it is a draft: the box says what is wanted (or answers what its refiner asked) and sends a helper to draft it. */
export function TodoDetail(props: { item: Issue; onDone: (id: string | undefined) => void }) {
  // Until the user edits a field, a draft coming back fills them.
  const [form, setForm] = createSignal({ draft: untrack(() => draftOf(props.item)), edited: false });
  const d = () => form().draft;
  const edited = () => form().edited;
  const act = createAct();
  const moves = useIntents(issueMove);
  const move = () => issueMoveOf(props.item.id, moves.list());
  const busy = () => act.busy() || move()?.state === "moving";
  const word = signal("");
  const newRepo = signal(false);
  const agents = useWorkAgents(true);
  const repoList = useRepos();
  const repos = () => ready(repoList, []).map((p) => p.name);

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

  const update = (x: Draft): IssueUpdate => ({
    title: x.title,
    description: x.description,
    repo: x.repo,
    agent: x.agent,
    priority: x.priority,
    deliver: x.deliver,
    criteria: criteriaList(x.criteria),
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

  const backlog = () => props.item.status === "backlog";
  const drafting = () => props.item.refining;
  const refined = () => isRefined(props.item);
  const questions = () => props.item.questions;
  const queued = () => props.item.queuedAt;
  const canSave = () => !busy() && d().title.trim() !== "";
  const canRefine = () => !busy() && !drafting() && (refined() || word().trim() !== "" || d().title.trim() !== newIssueTitle);
  const startable = () => canSave() && !drafting() && d().agent !== "";
  const said = (): [string, string] => {
    const by = drafting();
    return by
      ? [t("web.issue.todo.refining", { who: by.name }), t("web.issue.todo.refiningLine")]
      : questions().length > 0
        ? [t("web.issue.todo.questions", { n: questions().length }), t("web.issue.todo.questionsLine")]
        : refined()
          ? [t("web.issue.todo.drafted"), t("web.issue.todo.draftedLine")]
          : [t("web.issue.todo.what"), t("web.issue.todo.whatLine")];
  };

  const draft = () => {
    const id = props.item.id;
    const text = word().trim();
    const edit = unsaved();
    return act.run(async () => {
      saved(await api.issue.refine(omitUndefined({ id, text, edit })));
      word.set("");
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
  const remove = () => {
    const id = props.item.id;
    const done = props.onDone;
    return act.run(async () => {
      await api.issue.delete({ id });
      done(undefined);
    });
  };

  const criteria = () => criteriaList(d().criteria);
  const heading = (
    <View>
      <If when={props.item.parent}>
        {(parent) => (
          <View role="button" testID="parent-issue" class="mb-2 self-start" onPress={() => props.onDone(parent())}>
            <Text class="text-xs text-water">{t("web.issue.family.parent")}</Text>
          </View>
        )}
      </If>
      <If when={backlog()}>
        <View class="mb-4 pr-10">
          <Stages at="talk" />
        </View>
      </If>
      <Input
        testID="issue-title"
        value={d().title}
        onChange={(e) => edit({ title: e.value })}
        placeholder={t("web.issue.todo.titleHint")}
        accessibilityLabel={t("web.issue.todo.title")}
        class={`${bare} px-2 py-1 text-xl font-semibold`}
      />
    </View>
  );

  // One place to start from: a new draft is one sentence to draft from; its description and criteria come in once drafted,
  // written, or asked for (manual entry).
  const own = signal(false);
  const written = () => refined() || d().description.trim() !== "" || criteria().length > 0;
  const fields = () => written() || own() || !backlog();
  const talk = () => (
    <If when={backlog()}>
      <SheetLabel>{t("web.issue.todo.talk")}</SheetLabel>
      <Note tone={drafting() ? "water" : "wheat"}>
        <Text class="text-base font-semibold text-ink">{said()[0]}</Text>
        <Text class="mt-1 text-sm text-ink">{said()[1]}</Text>
        <Each of={questions()}>
          {(a) => (
            <View class="mt-1.5">
              <Text class="text-sm text-ink">{`· ${a().question}`}</Text>
              <If when={a().options.length}>
                <View class="mt-1 flex-row flex-wrap gap-1.5 pl-3" accessibilityLabel={t("web.issue.todo.answerTo", { question: a().question })}>
                  <Each of={a().options}>
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
      </Note>
      <TextArea
        testID="issue-talk"
        class="mt-2.5"
        rows={2}
        value={word()}
        onInput={word.set}
        submit
        onSubmit={() => canRefine() && void draft()}
        placeholder={questions().length > 0 ? t("web.issue.todo.answerHint") : refined() ? t("web.issue.todo.againHint") : t("web.issue.todo.whatHint")}
        accessibilityLabel={t("web.issue.todo.whatLabel")}
      />
      <View class="mt-2.5 flex-row flex-wrap gap-2">
        <Button
          tone={written() ? "primary" : "plain"}
          testID="issue-start"
          disabled={!startable()}
          accessibilityLabel={d().agent ? undefined : t("web.issue.todo.pickHelper")}
          onPress={() => void start()}
        >
          {t("web.issue.todo.start")}
        </Button>
        <Button testID="issue-draft" tone={written() ? "plain" : "primary"} disabled={!canRefine()} onPress={() => void draft()}>
          {refined() ? t("web.issue.todo.redraft") : t("web.issue.todo.draft")}
        </Button>
      </View>
    </If>
  );
  const main = (
    <>
      <If
        when={fields()}
        else={
          <>
            {talk()}
            <View role="button" testID="issue-write-own" onPress={() => own.set(true)} class="mt-3 self-start rounded-sm">
              <Text class="text-sm text-muted">{t("web.issue.todo.writeOwn")}</Text>
            </View>
          </>
        }
      >
        <Input
          multiline
          testID="issue-description"
          value={d().description}
          onChange={(e) => edit({ description: e.value })}
          placeholder={t("web.issue.todo.descriptionHint")}
          accessibilityLabel={t("web.issue.todo.description")}
          class={`${bare} px-2 py-1.5 text-base`}
          style={{ minHeight: 6 * 22 + 12 }}
        />
        <View class="mt-3 border-t border-line">
          <Fold
            label={t("web.issue.todo.criteria")}
            summary={
              criteria().length === 0
                ? t("web.issue.todo.noCriteria")
                : t("web.issue.todo.criteriaSummary", { n: criteria().length, first: criteria()[0] ?? "" })
            }
            open={criteria().length === 0}
          >
            <TextArea
              rows={3}
              value={d().criteria}
              onInput={(v) => edit({ criteria: v })}
              placeholder={t("web.issue.todo.criteriaHint")}
              accessibilityLabel={t("web.issue.todo.criteria")}
            />
          </Fold>
        </View>
        {talk()}
      </If>
      <IssueThread issue={props.item.id} />
      <IssueArtifacts issue={props.item.id} heading={<SheetLabel>{t("web.artifact.issue.title")}</SheetLabel>} />
    </>
  );

  const side = (
    <>
      <Property label={t("web.issue.todo.status")}>
        <View class="flex-row items-center gap-2">
          <View class={`h-2 w-2 rounded-full ${backlog() ? "bg-wheat" : "bg-water"}`} />
          <Text class="text-sm text-ink">{backlog() ? t("web.issue.todo.draftStatus") : t("web.issue.todo.todoStatus")}</Text>
        </View>
      </Property>
      <Property label={t("web.issue.detail.helper")}>
        <Pick
          label={t("web.issue.detail.helper")}
          testid="issue-helper"
          value={d().agent}
          placeholder={t("web.issue.todo.pickForMe")}
          onChange={(v) => edit({ agent: v })}
          options={agents().map((a) => ({ value: a.id, label: a.runtime ? `${a.name} · ${a.runtime}` : a.name }))}
        />
      </Property>
      <Property label={t("web.issue.task.repo")}>
        <Pick
          label={t("web.issue.task.repo")}
          testid="issue-repo"
          value={d().repo}
          placeholder={t("web.issue.todo.whichRepo")}
          onChange={(v) => edit({ repo: v })}
          options={[...new Set([...repos(), ...(d().repo ? [d().repo] : [])])].map((p) => ({ value: p, label: p }))}
        />
      </Property>
      <View role="button" testID="new-repo" onPress={() => newRepo.set(true)} class="mb-1 self-start" style={{ marginLeft: 76 }}>
        <Text class="text-xs text-water">{repos().length === 0 ? t("web.issue.todo.firstRepo") : t("web.issue.todo.newRepoLink")}</Text>
      </View>
      <Property label={t("web.issue.todo.priority")}>
        <Pick
          label={t("web.issue.todo.priority")}
          testid="issue-priority"
          value={d().priority}
          onChange={(v) => edit({ priority: v })}
          options={PriorityValues.map((p) => ({ value: p, label: t(`shared.priority.${p}`) }))}
        />
      </Property>
      <Property label={t("web.issue.detail.deliver")}>
        <Pick
          label={t("web.issue.detail.deliver")}
          testid="issue-deliver"
          value={d().deliver}
          onChange={(v) => edit({ deliver: v })}
          options={DeliverableValues.map((v) => ({ value: v, label: t(`shared.deliverable.${v}`) }))}
        />
      </Property>
      <More>
        <Property label={t("web.issue.task.written")}>{wallClockText(props.item.createdAt)}</Property>
      </More>
      <If when={queued()}>
        {(at) => (
          <Note tone="water" class="mt-2 p-2.5">
            <Text class="text-sm text-ink">{t("web.issue.todo.inQueue", { ago: ago(at(), Date.now()) })}</Text>
            <Button class="mt-1.5 self-start" testID="issue-unqueue" disabled={busy()} onPress={() => void unqueue()}>
              {t("web.issue.todo.unqueue")}
            </Button>
          </Note>
        )}
      </If>
      <View class="mt-4">
        <ActLines issue={props.item.id} />
      </View>
      <View class="flex-row flex-wrap gap-2">
        <If when={edited()}>
          <Button
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
        </If>
        <Button tone="quiet" testID="issue-remove" disabled={busy()} onPress={() => void remove()}>
          {t("web.issue.todo.remove")}
        </Button>
      </View>
      <If when={newRepo()}>
        <NewRepoDialog
          onClose={() => newRepo.set(false)}
          onMade={(name) => {
            newRepo.set(false);
            edit({ repo: name });
          }}
        />
      </If>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

function NewRepoDialog(props: { onClose: () => void; onMade: (name: string) => void }) {
  const queries = useQueryClient();
  const name = signal("");
  const act = createAct();
  const make = async () => {
    const wanted = name().trim();
    const made = await act.run(() => api.repo.create({ name: wanted }));
    if (!made) return;
    await queries.invalidate({ prefix: ["repos"] });
    props.onMade(made.name);
  };
  return (
    <Dialog open onClose={props.onClose} title={t("web.issue.todo.newRepo")} testid="new-repo-dialog">
      <TextInput
        autoFocus
        value={name()}
        onInput={name.set}
        onSubmit={() => name().trim() && void make()}
        placeholder={t("web.issue.todo.repoHint")}
        accessibilityLabel={t("web.issue.todo.repoName")}
      />
      <View class="mt-5 flex-row justify-end gap-2">
        <Button onPress={() => props.onClose()}>{t("web.issue.never")}</Button>
        <Button tone="primary" disabled={!name().trim() || act.busy()} onPress={() => void make()}>
          {t("web.issue.todo.create")}
        </Button>
      </View>
    </Dialog>
  );
}
