import { t } from "@vibevalley/i18n";

import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import { type Deliverable, DeliverableValues, type Issue, type IssueUpdate, type Priority, PriorityValues } from "@vibevalley/protocol";
import { api } from "@/base/api";
import { rememberPick } from "./write";
import { isRefined, newIssueTitle } from "./rules";
import { ago, wallClockText } from "@/base/format";
import { toast } from "@/ui/toasts";
import { autofocus } from "@/base/util";
import { useWorkAgents } from "@/base/agents";
import { ready, queries, useProjects } from "@/base/query";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { TextArea, TextInput } from "@/ui/Field";
import { run } from "./hooks";
import { IssueArtifacts } from "@/features/artifact";
import { Fold, IssueSheet, More, Note, Pick, Property, SheetLabel, Stages } from "./Sheet";
import { omitUndefined } from "@vibevalley/protocol/rules";

interface Draft {
  title: string;
  description: string;
  criteria: string;
  project: string;
  agent: string;
  priority: Priority;
  deliver: Deliverable;
}

const draftOf = (i: Issue): Draft => ({
  title: i.title,
  description: i.description,
  criteria: i.criteria.join("\n"),
  project: i.project ?? "",
  agent: i.assignee ?? "",
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

/** An issue not sent yet. In the backlog it is a draft: the box says what is wanted (or answers what its refiner asked)
 * and sends a helper to draft it; the fields are the draft, each editable; 开工 sends it out. */
export function TodoDetail(props: { item: Issue; onDone: (id: string | undefined) => void }) {
  const [d, setD] = createSignal(untrack(() => draftOf(props.item)));
  // Until the owner edits a field, a draft coming back fills them.
  const [edited, setEdited] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [word, setWord] = createSignal("");
  const [newProject, setNewProject] = createSignal(false);
  const agents = useWorkAgents(true);
  const projectList = useProjects();
  const projects = () => ready(projectList, []).map((p) => p.name);

  // The issue as the server has it now replaces the draft, unless the owner has started changing it.
  createEffect(
    () => draftOf(props.item),
    (fresh) => {
      if (!untrack(edited)) setD(fresh);
    },
    { defer: true },
  );

  const edit = (change: Partial<Draft>) => {
    setD((x) => ({ ...x, ...change }));
    setEdited(true);
  };

  const update = (x: Draft): IssueUpdate => {
    return {
      title: x.title,
      description: x.description,
      project: x.project,
      assignee: x.agent,
      priority: x.priority,
      deliver: x.deliver,
      criteria: criteriaList(x.criteria),
    };
  };

  // Saving goes with the act (edit): the server saves the fields before it acts on them. Taken when asked, so a call
  // that waits does not read them later.
  const unsaved = (): IssueUpdate | undefined => {
    if (!edited()) return undefined;
    const x = d();
    rememberPick(x.agent, x.project);
    return update(x);
  };
  const saved = <T,>(got: T) => {
    setEdited(false);
    return got;
  };

  async function busyWith(act: () => Promise<unknown>) {
    setBusy(true);
    await run(act);
    setBusy(false);
  }

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
    return busyWith(async () => {
      saved(await api.issue.refine(omitUndefined({ id, text, edit })));
      setWord("");
    });
  };
  const start = () => {
    const id = props.item.id;
    const x = d();
    rememberPick(x.agent, x.project);
    const told = dispatchedNotice(props.onDone);
    return busyWith(async () => {
      told(saved(await api.issue.status.update({ id, status: "todo", edit: update(x) })));
    });
  };
  const unqueue = () => {
    const id = props.item.id;
    return busyWith(() => api.issue.status.update({ id, status: "backlog" }));
  };
  const remove = () => {
    const id = props.item.id;
    const done = props.onDone;
    return busyWith(async () => {
      await api.issue.delete({ id });
      done(undefined);
    });
  };

  const criteria = () => criteriaList(d().criteria);
  const heading = (
    <div>
      <Show when={backlog()}>
        <div class="mb-4 pr-10">
          <Stages at="talk" />
        </div>
      </Show>
      <input
        data-testid="issue-title"
        value={d().title}
        onInput={(e) => edit({ title: e.currentTarget.value })}
        placeholder={t("web.issue.todo.titleHint")}
        aria-label={t("web.issue.todo.title")}
        class="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-xl font-semibold outline-none placeholder:text-faint hover:border-line focus:border-focus"
      />
    </div>
  );

  // One place to start from: a new draft is one sentence to draft from; its description and criteria come in once drafted,
  // written, or asked for (自己写).
  const [own, setOwn] = createSignal(false);
  const written = () => refined() || d().description.trim() !== "" || criteria().length > 0;
  const fields = () => written() || own() || !backlog();
  const talk = (
    <>
      <Show when={backlog()}>
        <SheetLabel>{t("web.issue.todo.talk")}</SheetLabel>
        <Note tone={drafting() ? "water" : "wheat"}>
          <div class="text-base font-semibold">{said()[0]}</div>
          <div class="mt-1">{said()[1]}</div>
          <For each={questions()}>
            {(a) => (
              <div class="mt-1.5">
                <div>· {a.question}</div>
                <Show when={a.options.length}>
                  <div class="mt-1 flex flex-wrap gap-1.5 pl-3" role="group" aria-label={t("web.issue.todo.answerTo", { question: a.question })}>
                    <For each={a.options}>
                      {(o) => (
                        <Button disabled={busy()} onClick={() => setWord(o)}>
                          {o}
                        </Button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Note>
        <TextArea
          class="mt-2.5"
          rows={2}
          value={word()}
          onInput={(e) => setWord(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing && canRefine()) {
              e.preventDefault();
              void draft();
            }
          }}
          placeholder={questions().length > 0 ? t("web.issue.todo.answerHint") : refined() ? t("web.issue.todo.againHint") : t("web.issue.todo.whatHint")}
          aria-label={t("web.issue.todo.whatLabel")}
        />
        <div class="mt-2.5">
          <Button tone={written() ? "plain" : "primary"} disabled={!canRefine()} onClick={() => void draft()}>
            {refined() ? t("web.issue.todo.redraft") : t("web.issue.todo.draft")}
          </Button>
        </div>
      </Show>
    </>
  );
  const main = (
    <>
      <Show
        when={fields()}
        fallback={
          <>
            {talk}
            <button
              type="button"
              data-testid="issue-write-own"
              onClick={() => setOwn(true)}
              class="mt-3 block cursor-pointer rounded-sm text-left text-sm text-muted hover:text-ink hover:underline"
            >
              {t("web.issue.todo.writeOwn")}
            </button>
          </>
        }
      >
        <textarea
          data-testid="issue-description"
          value={d().description}
          onInput={(e) => edit({ description: e.currentTarget.value })}
          rows={6}
          placeholder={t("web.issue.todo.descriptionHint")}
          aria-label={t("web.issue.todo.description")}
          class="w-full resize-y rounded-md border border-transparent bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-faint hover:border-line focus:border-focus"
        />
        <div class="mt-3 border-t border-line">
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
              onInput={(e) => edit({ criteria: e.currentTarget.value })}
              placeholder={t("web.issue.todo.criteriaHint")}
              aria-label={t("web.issue.todo.criteria")}
            />
          </Fold>
        </div>
        {talk}
      </Show>
      <IssueArtifacts issue={props.item.id} heading={<SheetLabel>{t("web.artifact.issue.title")}</SheetLabel>} />
    </>
  );

  const side = (
    <>
      <Property label={t("web.issue.todo.status")}>
        <span class="flex items-center gap-2">
          <span class={["size-2 rounded-full", backlog() ? "bg-wheat" : "bg-water"]} />
          {backlog() ? t("web.issue.todo.draftStatus") : t("web.issue.todo.todoStatus")}
        </span>
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
      <Property label={t("web.issue.task.project")}>
        <Pick
          label={t("web.issue.task.project")}
          testid="issue-project"
          value={d().project}
          placeholder={t("web.issue.todo.whichProject")}
          onChange={(v) => edit({ project: v })}
          options={[...new Set([...projects(), ...(d().project ? [d().project] : [])])].map((p) => ({ value: p, label: p }))}
        />
      </Property>
      <button type="button" onClick={() => setNewProject(true)} class="mb-1 ml-[76px] cursor-pointer self-start text-xs text-water hover:underline">
        {projects().length === 0 ? t("web.issue.todo.firstProject") : t("web.issue.todo.newProjectLink")}
      </button>
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
      <Show when={queued()}>
        {(at) => (
          <Note tone="water" class="mt-2 !p-2.5">
            <div>{t("web.issue.todo.inQueue", { ago: ago(at(), Date.now()) })}</div>
            <Button class="mt-1.5" disabled={busy()} onClick={() => void unqueue()}>
              {t("web.issue.todo.unqueue")}
            </Button>
          </Note>
        )}
      </Show>
      <div class="mt-4 flex flex-wrap gap-2">
        <Show when={backlog()}>
          <Button
            tone={written() ? "primary" : "plain"}
            data-testid="issue-start"
            disabled={!startable()}
            title={d().agent ? undefined : t("web.issue.todo.pickHelper")}
            onClick={() => void start()}
          >
            {t("web.issue.todo.start")}
          </Button>
        </Show>
        <Show when={edited()}>
          <Button
            data-testid="issue-save"
            disabled={!canSave()}
            onClick={() => {
              const id = props.item.id;
              const edit = unsaved();
              if (edit) void busyWith(async () => saved(await api.issue.update({ id, ...edit })));
            }}
          >
            {t("web.issue.todo.save")}
          </Button>
        </Show>
        <Button tone="quiet" data-testid="issue-remove" disabled={busy()} onClick={() => void remove()}>
          {t("web.issue.todo.remove")}
        </Button>
      </div>
      <Show when={newProject()}>
        <NewProjectDialog
          onClose={() => setNewProject(false)}
          onMade={(name) => {
            setNewProject(false);
            edit({ project: name });
          }}
        />
      </Show>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

function NewProjectDialog(props: { onClose: () => void; onMade: (name: string) => void }) {
  const [name, setName] = createSignal("");
  const make = async () => {
    const wanted = name().trim();
    const made = await run(() => api.project.create({ name: wanted }));
    if (!made) return;
    await queries.invalidateQueries({ queryKey: ["projects"] });
    props.onMade(made.name);
  };
  return (
    <Dialog open onClose={props.onClose} title={t("web.issue.todo.newProject")}>
      <TextInput
        ref={autofocus()}
        value={name()}
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Enter" && name().trim() && void make()}
        placeholder={t("web.issue.todo.projectHint")}
        aria-label={t("web.issue.todo.projectName")}
      />
      <div class="mt-5 flex justify-end gap-2">
        <Button onClick={() => props.onClose()}>{t("web.issue.never")}</Button>
        <Button tone="primary" disabled={!name().trim()} onClick={() => void make()}>
          {t("web.issue.todo.create")}
        </Button>
      </div>
    </Dialog>
  );
}
