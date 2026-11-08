import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Deliverable, DeliverableValues, type Issue, type IssueUpdate, type Priority, PriorityValues } from "@vibevalley/protocol";
import { assignedAgentOf, omitUndefined } from "@vibevalley/protocol/rules";

import { autofocus } from "#/base/dom.tsx";
import { ago, wallClockText } from "#/base/format.ts";
import { IssueArtifacts } from "#/features/artifact/index.ts";
import { useWorkAgents } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { ready, useQueryClient, useRepos } from "#/infra/query.ts";
import { useIntents } from "#/state/intent.ts";
import { rememberPick } from "#/state/prefs.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Dialog } from "#/ui/Dialog.tsx";
import { TextArea, TextInput } from "#/ui/Field.tsx";
import { toast } from "#/ui/toasts.ts";

import { ActLines } from "./ActLines";
import { isRefined, newIssueTitle } from "./issue";
import { IssueThread } from "./IssueThread";
import { issueMove, issueMoveOf, sendMove } from "./moves";
import { Fold, IssueSheet, More, Note, Pick, Property, SheetLabel, Stages } from "./Sheet";

const viewStyles = stylex.create({
  parentIssue: {
    marginBottom: "calc(var(--spacing) * 2)",
    cursor: "pointer",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  todoDetailDiv: {
    marginBottom: "calc(var(--spacing) * 4)",
    paddingRight: "calc(var(--spacing) * 10)",
  },
  issueTitle: {
    width: "100%",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "transparent",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-line)",
      },
      ":focus": "var(--wb-focus)",
    },
    backgroundColor: "transparent",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-xl)",
    lineHeight: "var(--text-xl--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    outlineStyle: "none",
    color: {
      default: null,
      "::placeholder": "var(--wb-faint)",
    },
  },
  todoDetailDiv2: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  todoDetailDiv3: {
    marginTop: "var(--spacing)",
  },
  todoDetailDiv4: {
    marginTop: "calc(var(--spacing) * 1.5)",
  },
  todoDetailDiv5: {
    marginTop: "var(--spacing)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 1.5)",
    paddingLeft: "calc(var(--spacing) * 3)",
  },
  todoDetailDiv6: {
    marginTop: "calc(var(--spacing) * 2.5)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  issueWriteOwn: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "block",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    textAlign: "left",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  issueDescription: {
    width: "100%",
    resize: "vertical",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "transparent",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-line)",
      },
      ":focus": "var(--wb-focus)",
    },
    backgroundColor: "transparent",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    outlineStyle: "none",
    color: {
      default: null,
      "::placeholder": "var(--wb-faint)",
    },
  },
  todoDetailDiv7: {
    marginTop: "calc(var(--spacing) * 3)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--wb-line)",
  },
  todoDetailSpan: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  todoDetailButton: {
    marginBottom: "var(--spacing)",
    marginLeft: "76px",
    cursor: "pointer",
    alignSelf: "flex-start",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  todoDetailDiv8: {
    marginTop: "calc(var(--spacing) * 4)",
  },
  todoDetailDiv9: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  newRepoDialogDiv: {
    marginTop: "calc(var(--spacing) * 5)",
    display: "flex",
    justifyContent: "flex-end",
    gap: "calc(var(--spacing) * 2)",
  },
});

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

/** An issue not sent yet. In the backlog it is a draft: the box says what is wanted (or answers what its refiner asked) and sends a helper to draft it. */
export function TodoDetail(props: { item: Issue; onDone: (id: string | undefined) => void }) {
  const [d, setD] = createSignal(untrack(() => draftOf(props.item)));
  // Until the owner edits a field, a draft coming back fills them.
  const [edited, setEdited] = createSignal(false);
  const act = createAct();
  const moves = useIntents(issueMove);
  const move = () => issueMoveOf(props.item.id, moves.list());
  const busy = () => act.busy() || move()?.state === "moving";
  const [word, setWord] = createSignal("");
  const [newRepo, setNewRepo] = createSignal(false);
  const agents = useWorkAgents(true);
  const repoList = useRepos();
  const repos = () => ready(repoList, []).map((p) => p.name);

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
      repo: x.repo,
      agent: x.agent,
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
    rememberPick(x.agent, x.repo);
    return update(x);
  };
  const saved = <T,>(got: T) => {
    setEdited(false);
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
      setWord("");
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
    <div>
      <Show when={props.item.parent}>
        {(parent) => (
          <button type="button" data-testid="parent-issue" {...stylex.attrs(viewStyles.parentIssue)} onClick={() => props.onDone(parent())}>
            {t("web.issue.family.parent")}
          </button>
        )}
      </Show>
      <Show when={backlog()}>
        <div {...stylex.attrs(viewStyles.todoDetailDiv)}>
          <Stages at="talk" />
        </div>
      </Show>
      <input
        data-testid="issue-title"
        value={d().title}
        onInput={(e) => edit({ title: e.currentTarget.value })}
        placeholder={t("web.issue.todo.titleHint")}
        aria-label={t("web.issue.todo.title")}
        {...stylex.attrs(viewStyles.issueTitle)}
      />
    </div>
  );

  // One place to start from: a new draft is one sentence to draft from; its description and criteria come in once drafted,
  // written, or asked for (manual entry).
  const [own, setOwn] = createSignal(false);
  const written = () => refined() || d().description.trim() !== "" || criteria().length > 0;
  const fields = () => written() || own() || !backlog();
  const talk = (
    <>
      <Show when={backlog()}>
        <SheetLabel>{t("web.issue.todo.talk")}</SheetLabel>
        <Note tone={drafting() ? "water" : "wheat"}>
          <div {...stylex.attrs(viewStyles.todoDetailDiv2)}>{said()[0]}</div>
          <div {...stylex.attrs(viewStyles.todoDetailDiv3)}>{said()[1]}</div>
          <For each={questions()}>
            {(a) => (
              <div {...stylex.attrs(viewStyles.todoDetailDiv4)}>
                <div>· {a.question}</div>
                <Show when={a.options.length}>
                  <div {...stylex.attrs(viewStyles.todoDetailDiv5)} role="group" aria-label={t("web.issue.todo.answerTo", { question: a.question })}>
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
        <div {...stylex.attrs(viewStyles.todoDetailDiv6)}>
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
            <button type="button" data-testid="issue-write-own" onClick={() => setOwn(true)} {...stylex.attrs(viewStyles.issueWriteOwn)}>
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
          {...stylex.attrs(viewStyles.issueDescription)}
        />
        <div {...stylex.attrs(viewStyles.todoDetailDiv7)}>
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
      <IssueThread issue={props.item.id} />
      <IssueArtifacts issue={props.item.id} heading={<SheetLabel>{t("web.artifact.issue.title")}</SheetLabel>} />
    </>
  );

  const side = (
    <>
      <Property label={t("web.issue.todo.status")}>
        <span {...stylex.attrs(viewStyles.todoDetailSpan)}>
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
      <button type="button" onClick={() => setNewRepo(true)} {...stylex.attrs(viewStyles.todoDetailButton)}>
        {repos().length === 0 ? t("web.issue.todo.firstRepo") : t("web.issue.todo.newRepoLink")}
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
      <div {...stylex.attrs(viewStyles.todoDetailDiv8)}>
        <ActLines issue={props.item.id} />
      </div>
      <div {...stylex.attrs(viewStyles.todoDetailDiv9)}>
        <Show when={edited()}>
          <Button
            data-testid="issue-save"
            disabled={!canSave()}
            onClick={() => {
              const id = props.item.id;
              const edit = unsaved();
              if (edit) void act.run(async () => saved(await api.issue.update({ id, ...edit })));
            }}
          >
            {t("web.issue.todo.save")}
          </Button>
        </Show>
        <Button tone="quiet" data-testid="issue-remove" disabled={busy()} onClick={() => void remove()}>
          {t("web.issue.todo.remove")}
        </Button>
      </div>
      <Show when={newRepo()}>
        <NewRepoDialog
          onClose={() => setNewRepo(false)}
          onMade={(name) => {
            setNewRepo(false);
            edit({ repo: name });
          }}
        />
      </Show>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

function NewRepoDialog(props: { onClose: () => void; onMade: (name: string) => void }) {
  const queries = useQueryClient();
  const [name, setName] = createSignal("");
  const act = createAct();
  const make = async () => {
    const wanted = name().trim();
    const made = await act.run(() => api.repo.create({ name: wanted }));
    if (!made) return;
    await queries.invalidate({ prefix: ["repos"] });
    props.onMade(made.name);
  };
  return (
    <Dialog open onClose={props.onClose} title={t("web.issue.todo.newRepo")}>
      <TextInput
        ref={autofocus()}
        value={name()}
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Enter" && name().trim() && void make()}
        placeholder={t("web.issue.todo.repoHint")}
        aria-label={t("web.issue.todo.repoName")}
      />
      <div {...stylex.attrs(viewStyles.newRepoDialogDiv)}>
        <Button onClick={() => props.onClose()}>{t("web.issue.never")}</Button>
        <Button tone="primary" disabled={!name().trim() || act.busy()} onClick={() => void make()}>
          {t("web.issue.todo.create")}
        </Button>
      </div>
    </Dialog>
  );
}
