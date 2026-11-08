import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ChangedFile, Changes, Issue, IssueAct, Session } from "@vibevalley/protocol";

import { aria, autofocus } from "#/base/dom.tsx";
import { ago } from "#/base/format.ts";
import { reasonOf } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { ready } from "#/infra/query.ts";
import { useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { highlight, type Tokens } from "#/ui/code/highlight.ts";
import { Dialog } from "#/ui/Dialog.tsx";
import { TextArea } from "#/ui/Field.tsx";

import { actionOf, perform } from "./acts";
import { type Lane } from "./cards";
import { changeKind, lineCounts, nothingChanged, patchLines, patchMarkOf } from "./changes";
import { useIssueChanges } from "./history";
import { issueTitle } from "./issue";
import { issueMove, sendMove } from "./moves";
import { Note } from "./Sheet";

const viewStyles = stylex.create({
  doneAction: { marginTop: "calc(var(--spacing) * 4)" },
  closeIssueDialogP: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
  },
  closeIssueDialogDiv: {
    marginTop: "calc(var(--spacing) * 5)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  changesReviewP: {
    paddingBlock: "calc(var(--spacing) * 10)",
    textAlign: "center",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  changesReviewSpan: {
    color: "var(--wb-berry)",
  },
  changesReviewDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  changesReviewSpan2: {
    color: "var(--wb-muted)",
  },
  changesReviewDiv2: {
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--wb-berry)",
  },
  changesReviewDiv3: {
    marginTop: "calc(var(--spacing) * 1.5)",
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
  },
  changesReviewSpan3: {
    borderRadius: ".25rem",
    backgroundColor: "var(--wb-page)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-berry)",
  },
  changesReviewDiv4: {
    marginTop: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  changesReviewP2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  changesReviewSpan4: {
    borderRadius: ".25rem",
    backgroundColor: "var(--wb-page)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  changesReviewDiv5: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  changesHeadDiv: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  changesHeadSpan: {
    borderRadius: ".25rem",
    backgroundColor: "var(--wb-selected)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  changesHeadSpan2: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  changesBodyH3: {
    marginTop: "calc(var(--spacing) * 2)",
    marginBottom: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--wb-muted)",
  },
  changesBodyDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
  },
  changesBodySpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  changesBodySpan2: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  changesBodySpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-faint)",
  },
  plusMinusSpan: {
    color: "var(--wb-accent)",
  },
  fileRowSpan: {
    borderRadius: ".25rem",
    backgroundColor: {
      default: "var(--wb-berry)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-berry) 15%, transparent)",
    },
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-berry)",
  },
  patchPre: {
    marginInline: "calc(var(--spacing) * 2)",
    marginBottom: "calc(var(--spacing) * 2)",
    maxHeight: "calc(var(--spacing) * 80)",
    overflow: "auto",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--wb-page)",
    paddingBlock: "var(--spacing)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "1.4",
  },
  reopenDialogDiv: {
    marginTop: "calc(var(--spacing) * 5)",
    display: "flex",
    justifyContent: "flex-end",
    gap: "calc(var(--spacing) * 2)",
  },
});

/** Closing an issue: complete it (its changes first) or cancel it. `review` opens straight on the changes. */
export function CloseIssueDialog(props: { issue: Issue; session?: Session | undefined; review?: boolean; lane?: Lane | undefined; onClose: () => void }) {
  const [reviewing, setReviewing] = createSignal(untrack(() => props.review ?? false));
  const core = useCore();
  const live = () => core()?.issues.find((i) => i.id === props.issue.id);
  const acts = () => (live()?.stage.acts ?? []).map((a) => a.act);
  const working = () => acts().includes("stop");
  const presses = createPresses(() => props.lane);
  const cancel = async () => {
    if (await presses.press(live(), "close")) props.onClose();
  };
  return (
    <Dialog open onClose={props.onClose} title={t("web.issue.close.title", { issue: issueTitle(props.issue) })} wide={reviewing()} testid="close-issue">
      <Show when={!reviewing()} fallback={<ChangesReview issue={props.issue.id} lane={props.lane} onDone={props.onClose} />}>
        <div>
          <p {...stylex.attrs(viewStyles.closeIssueDialogP)}>
            {working()
              ? t("web.issue.close.working", { who: props.session?.name ?? props.issue.title })
              : acts().includes("complete")
                ? t("web.issue.close.completable", { who: props.session?.name ?? props.issue.title })
                : t("web.issue.close.notCompletable", { who: props.session?.name ?? props.issue.title })}
          </p>
          <div {...stylex.attrs(viewStyles.closeIssueDialogDiv)}>
            <Show when={acts().includes("complete")}>
              <Button tone="primary" data-testid="review-changes" onClick={() => setReviewing(true)}>
                {t("web.issue.close.review")}
              </Button>
            </Show>
            <Show when={acts().includes("close")}>
              <Button tone="danger" data-act="close" onClick={() => void cancel()}>
                {working() ? t("web.issue.close.stopAndCancel") : t("web.issue.close.cancel")}
              </Button>
            </Show>
            <Button onClick={() => props.onClose()}>{t("web.issue.never")}</Button>
          </div>
        </div>
      </Show>
    </Dialog>
  );
}

/** The dialog's buttons. A move is an intent: the dialog closes once it is sent, and the board and the issue's page show it moving, or refused with a retry. */
function createPresses(lane: () => Lane | undefined) {
  const moves = useIntents(issueMove);
  const act = createAct();
  return {
    /** False when the issue does not offer it or the press did not go through. */
    press: async (issue: Issue | undefined, pressed: IssueAct) => {
      const a = issue && actionOf(issue, pressed);
      if (!issue || !a) return false;
      if (a.does === "move") {
        // The lane it was dropped on is where closing puts it; a resolve sends it back to work instead.
        const to = pressed === "resolve" ? undefined : lane();
        void sendMove(moves, { id: issue.id, status: a.status, ...(to ? { lane: to } : {}) });
        return true;
      }
      return (await act.run(async () => (await perform(issue, a), true))) === true;
    },
  };
}

/** What the branch brings before it is merged. */
function ChangesReview(props: { issue: string; lane?: Lane | undefined; onDone: () => void }) {
  const changes = useIssueChanges(() => props.issue);
  const core = useCore();
  const live = () => core()?.issues.find((i) => i.id === props.issue);
  const acts = () => (live()?.stage.acts ?? []).map((a) => a.act);
  const presses = createPresses(() => props.lane);
  const take = async () => {
    if (await presses.press(live(), "complete")) props.onDone();
  };
  const resolve = async () => {
    if (await presses.press(live(), "resolve")) props.onDone();
  };
  return (
    <Switch>
      <Match when={changes.status() === "pending"}>
        <p {...stylex.attrs(viewStyles.changesReviewP)}>{t("web.issue.changes.reading")}</p>
      </Match>
      <Match when={changes.error()}>
        {(error) => (
          <div>
            <Note tone="berry">
              <span {...stylex.attrs(viewStyles.changesReviewSpan)}>
                {t("web.issue.changes.unreadable")}
                {reasonOf(error())}
              </span>
            </Note>
            <Button styles={viewStyles.doneAction} onClick={() => props.onDone()}>
              {t("web.issue.later")}
            </Button>
          </div>
        )}
      </Match>
      <Match when={ready(changes, undefined)}>
        {(c) => {
          const empty = () => nothingChanged(c());
          return (
            <div {...stylex.attrs(viewStyles.changesReviewDiv)}>
              <ChangesHead changes={c()} />
              <Show
                when={c().conflicts.length > 0}
                fallback={
                  <Show when={empty()}>
                    <Note>
                      <span {...stylex.attrs(viewStyles.changesReviewSpan2)}>{t("web.issue.changes.none")}</span>
                    </Note>
                  </Show>
                }
              >
                <Note tone="berry">
                  <div {...stylex.attrs(viewStyles.changesReviewDiv2)}>{t("web.issue.changes.conflict", { base: c().base })}</div>
                  <div {...stylex.attrs(viewStyles.changesReviewDiv3)}>
                    <For each={c().conflicts}>{(f) => <span {...stylex.attrs(viewStyles.changesReviewSpan3)}>{f}</span>}</For>
                  </div>
                  <div {...stylex.attrs(viewStyles.changesReviewDiv4)}>{t("web.issue.changes.resolveHow", { base: c().base })}</div>
                </Note>
              </Show>
              <Show when={c().behind > 0 && c().conflicts.length === 0}>
                <p {...stylex.attrs(viewStyles.changesReviewP2)}>{t("web.issue.changes.behind", { base: c().base, n: c().behind })}</p>
              </Show>
              <Show when={c().uncommitted.length > 0}>
                <Note tone="wheat">
                  <div>{t("web.issue.changes.uncommitted", { n: c().uncommitted.length })}</div>
                  <div {...stylex.attrs(viewStyles.changesReviewDiv3)}>
                    <For each={c().uncommitted}>
                      {(f) => (
                        <span {...stylex.attrs(viewStyles.changesReviewSpan4)}>
                          {changeKind(f.status).mark} {f.path}
                        </span>
                      )}
                    </For>
                  </div>
                </Note>
              </Show>
              <div {...stylex.attrs(viewStyles.changesReviewDiv5)}>
                <Show when={acts().includes("complete")}>
                  <Button tone="primary" data-act="complete" onClick={() => void take()}>
                    {t("shared.act.complete")}
                  </Button>
                </Show>
                <Show when={acts().includes("resolve")}>
                  <Button tone="danger" data-act="resolve" onClick={() => void resolve()}>
                    {t("web.issue.changes.resolve")}
                  </Button>
                </Show>
                <Button onClick={() => props.onDone()}>{t("web.issue.later")}</Button>
              </div>
              <Show when={!acts().includes("complete") && !acts().includes("resolve")}>
                <p {...stylex.attrs(viewStyles.changesReviewP2)}>{t("web.issue.changes.moved")}</p>
              </Show>
              <ChangesBody changes={c()} />
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}

export function ChangesHead(props: { changes: Changes }) {
  const counts = () => lineCounts(props.changes);
  return (
    <div {...stylex.attrs(viewStyles.changesHeadDiv)}>
      <span {...stylex.attrs(viewStyles.changesHeadSpan)}>
        {t("web.issue.task.repo")} {props.changes.repo}
      </span>
      <Show when={props.changes.branch}>
        <span {...stylex.attrs(viewStyles.changesHeadSpan2)}>
          {props.changes.branch} → {props.changes.base}
        </span>
      </Show>
      <span {...stylex.attrs(viewStyles.changesReviewP2)}>
        {t("web.issue.changes.counts", { commits: props.changes.commits.length, files: props.changes.files.length })}
      </span>
      <Show when={props.changes.files.length > 0}>
        <PlusMinus added={counts()[0]} removed={counts()[1]} />
      </Show>
    </div>
  );
}

/** The commits and the files, each file opening to its patch. */
export function ChangesBody(props: { changes: Changes }) {
  const now = Date.now();
  return (
    <>
      <Show when={props.changes.commits.length > 0}>
        <section>
          <h3 {...stylex.attrs(viewStyles.changesBodyH3)}>{t("web.issue.changes.commits", { n: props.changes.commits.length })}</h3>
          <For each={props.changes.commits}>
            {(m) => (
              <div {...stylex.attrs(viewStyles.changesBodyDiv)}>
                <span {...stylex.attrs(viewStyles.changesBodySpan)}>{m.hash}</span>
                <span {...stylex.attrs(viewStyles.changesBodySpan2)}>{m.subject}</span>
                <span {...stylex.attrs(viewStyles.changesBodySpan3)}>{ago(m.at, now)}</span>
              </div>
            )}
          </For>
        </section>
      </Show>
      <Show when={props.changes.files.length > 0}>
        <section>
          <h3 {...stylex.attrs(viewStyles.changesBodyH3)}>{t("web.issue.changes.files", { n: props.changes.files.length })}</h3>
          <div class="divide-y divide-line overflow-hidden rounded-md border border-line">
            <For each={props.changes.files}>{(f) => <FileRow file={f} conflict={props.changes.conflicts.includes(f.path)} />}</For>
          </div>
        </section>
      </Show>
    </>
  );
}

function PlusMinus(props: { added: number; removed: number }) {
  return (
    <span {...stylex.attrs(viewStyles.changesHeadSpan2)}>
      <span {...stylex.attrs(viewStyles.plusMinusSpan)}>+{props.added}</span> <span {...stylex.attrs(viewStyles.changesReviewSpan)}>−{props.removed}</span>
    </span>
  );
}

const kindLook: Record<string, string> = { A: "bg-leaf/20 text-accent", M: "bg-wheat/20 text-bark", D: "bg-berry/15 text-berry" };

function FileRow(props: { file: ChangedFile; conflict: boolean }) {
  const [open, setOpen] = createSignal(false);
  const kind = () => changeKind(props.file.status);
  const hasPatch = () => !!props.file.patch;
  return (
    <div>
      <button
        type="button"
        data-testid="changed-file"
        data-key={props.file.path}
        disabled={!hasPatch()}
        aria-expanded={hasPatch() ? aria(open()) : undefined}
        onClick={() => setOpen(!open())}
        class={["flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left", { "cursor-pointer hover:bg-hover": hasPatch(), "bg-hover": open() }]}
      >
        <span
          title={kind().label}
          class={["flex size-5 shrink-0 items-center justify-center rounded text-xs font-semibold", kindLook[props.file.status] ?? "bg-selected"]}
        >
          {kind().mark}
        </span>
        <span title={props.file.path} class={["min-w-0 flex-1 truncate font-mono text-xs", { "text-berry": props.conflict }]}>
          {props.file.path}
        </span>
        <Show when={props.conflict}>
          <span {...stylex.attrs(viewStyles.fileRowSpan)}>{t("web.issue.changes.conflictMark")}</span>
        </Show>
        <Show when={props.file.added >= 0} fallback={<span {...stylex.attrs(viewStyles.changesBodySpan)}>{t("web.issue.changes.binary")}</span>}>
          <PlusMinus added={Math.round(props.file.added)} removed={Math.round(props.file.removed)} />
        </Show>
      </button>
      <Show when={open() ? props.file.patch : undefined}>{(patch) => <Patch text={patch()} path={props.file.path} />}</Show>
    </div>
  );
}

const patchLook = { added: "bg-leaf/20 text-accent", removed: "bg-berry/10 text-berry", hunk: "text-water", plain: "" } as const;

/** A file's patch: each line marked added or removed, its code coloured in the file's language once the colours come (ui/code: off the page's thread. */
function Patch(props: { text: string; path: string }) {
  const lines = () => patchLines(props.text);
  // The code without its +, - or space: coloured as one block, so a line reads in the context of those above it.
  const code = () =>
    lines()
      .filter((l) => patchMarkOf(l) !== "hunk")
      .map((l) => l.slice(1));
  const [tokens, setTokens] = createSignal<Tokens>();
  createEffect(
    () => [code(), props.path] as const,
    ([c, path]) => {
      setTokens(undefined);
      let live = true;
      void highlight(c, path).then((got) => live && setTokens(got));
      return () => {
        live = false;
      };
    },
  );
  // Each line's place among the coloured ones: hunk headers are not in the block.
  const row = (i: number) =>
    lines()
      .slice(0, i)
      .filter((l) => patchMarkOf(l) !== "hunk").length;
  return (
    <pre {...stylex.attrs(viewStyles.patchPre)}>
      <For each={lines()}>
        {(line, i) => {
          const mark = patchMarkOf(line);
          const coloured = () => (mark === "hunk" ? undefined : tokens()?.[row(i())]);
          return (
            <div class={["px-2", patchLook[mark]]}>
              <Show when={coloured()} fallback={line || " "}>
                {(toks) => (
                  <>
                    {line.slice(0, 1)}
                    <For each={toks()}>{(tok) => <span style={tok.color ? { color: tok.color } : undefined}>{tok.text}</span>}</For>
                  </>
                )}
              </Show>
            </div>
          );
        }}
      </For>
    </pre>
  );
}

/** Reopening a closed issue: a new helper of the same profile goes on with it. */
export function ReopenDialog(props: { issue: Issue; lane?: Lane | undefined; onClose: () => void; onReopened: () => void }) {
  const [text, setText] = createSignal("");
  const moves = useIntents(issueMove);
  // The card shows in the lane it was dropped on, moving, from the press on; the issue opens once the server took it.
  const reopen = () => {
    const words = text().trim();
    const done = sendMove(moves, { id: props.issue.id, status: "todo", text: words, ...(props.lane ? { lane: props.lane } : {}) }).done;
    const reopened = props.onReopened;
    props.onClose();
    void done.then((d) => d?.replied !== undefined && reopened());
  };
  return (
    <Dialog open onClose={props.onClose} title={t("web.issue.reopen.title")}>
      <p {...stylex.attrs(viewStyles.closeIssueDialogP)}>{t("web.issue.reopen.line", { issue: issueTitle(props.issue) })}</p>
      <TextArea
        ref={autofocus()}
        class="mt-4"
        rows={3}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        placeholder={t("web.issue.reopen.what")}
        aria-label={t("web.issue.reopen.whatLabel")}
      />
      <div {...stylex.attrs(viewStyles.reopenDialogDiv)}>
        <Button onClick={() => props.onClose()}>{t("web.issue.never")}</Button>
        <Button tone="primary" onClick={() => reopen()}>
          {t("web.issue.reopen.reopen")}
        </Button>
      </div>
    </Dialog>
  );
}
