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
import { styleProps } from "#/ui/positioner.ts";

import { actionOf, perform } from "./acts";
import { type Lane } from "./cards";
import { changeKind, lineCounts, nothingChanged, patchLines, patchMarkOf } from "./changes";
import { useIssueChanges } from "./history";
import { issueTitle } from "./issue";
import { issueMove, sendMove } from "./moves";
import { Note } from "./Sheet";

const changeStyles = stylex.create({
  files: {
    overflow: "hidden",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
  },
  kind: {
    display: "flex",
    width: "1.25rem",
    height: "1.25rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
  },
  added: {
    backgroundColor: {
      default: "var(--wb-leaf)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-leaf) 20%, transparent)",
    },
    color: "var(--wb-accent)",
  },
  modified: {
    backgroundColor: {
      default: "var(--wb-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-wheat) 20%, transparent)",
    },
    color: "var(--wb-bark)",
  },
  deleted: {
    backgroundColor: {
      default: "var(--wb-berry)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-berry) 15%, transparent)",
    },
    color: "var(--wb-berry)",
  },
  unknown: {
    backgroundColor: "var(--wb-selected)",
  },
  file: {
    borderTopStyle: {
      default: null,
      ":not(:last-child)": "solid",
    },
    borderBottomStyle: {
      default: null,
      ":not(:last-child)": "solid",
    },
    borderTopWidth: {
      default: null,
      ":not(:last-child)": "0px",
    },
    borderBottomWidth: {
      default: null,
      ":not(:last-child)": "1px",
    },
    borderColor: {
      default: null,
      ":not(:last-child)": "var(--color-line)",
    },
  },
});

const styles = stylex.create({
  fileRowButton: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "0.625rem",
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
    textAlign: "left",
  },
  fileRowButtonState: {
    backgroundColor: null,
    cursor: null,
  },
  fileRowButtonState2: {
    backgroundColor: "var(--wb-hover)",
    cursor: null,
  },
  fileRowButtonState3: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
    cursor: "pointer",
  },
  fileRowButtonState4: {
    backgroundColor: {
      default: "var(--wb-hover)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
    cursor: "pointer",
  },
  patchDiv: {
    paddingInline: "0.5rem",
  },
  patchDivPrimary: {
    backgroundColor: {
      default: "var(--color-leaf)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf) 20%, transparent)",
    },
    color: "var(--color-accent)",
  },
  patchDivSecondary: {
    backgroundColor: {
      default: "var(--color-berry)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-berry) 10%, transparent)",
    },
    color: "var(--color-berry)",
  },
  patchDivTertiary: {
    backgroundColor: null,
    color: "var(--color-water)",
  },
  patchDivQuaternary: {
    backgroundColor: null,
    color: null,
  },
  reopenDialogTextArea: {
    marginTop: "1rem",
  },
  fileRowSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  fileRowSpanTone: {
    color: "var(--color-berry)",
  },
  fileRowSpanAlt: {},
  doneAction: { marginTop: "1rem" },
  closeIssueDialogP: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
  },
  closeIssueDialogDiv: {
    marginTop: "1.25rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  changesReviewP: {
    paddingBlock: "2.5rem",
    textAlign: "center",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  changesReviewSpan: {
    color: "var(--color-berry)",
  },
  changesReviewDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  changesReviewSpan2: {
    color: "var(--color-muted)",
  },
  changesReviewDiv2: {
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-berry)",
  },
  changesReviewDiv3: {
    marginTop: "0.375rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
  },
  changesReviewSpan3: {
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-page)",
    paddingInline: "0.375rem",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-berry)",
  },
  changesReviewDiv4: {
    marginTop: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  changesReviewP2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  changesReviewSpan4: {
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-page)",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  changesReviewDiv5: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  changesHeadDiv: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  changesHeadSpan: {
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-selected)",
    paddingInline: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  changesHeadSpan2: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  changesBodyH3: {
    marginTop: "0.5rem",
    marginBottom: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  changesBodyDiv: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    paddingBlock: "0.125rem",
  },
  changesBodySpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  changesBodySpan2: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  changesBodySpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  plusMinusSpan: {
    color: "var(--color-accent)",
  },
  fileRowSpan2: {
    borderRadius: "var(--radius-sm)",
    backgroundColor: {
      default: "var(--color-berry)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-berry) 15%, transparent)",
    },
    paddingInline: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-berry)",
  },
  patchPre: {
    marginInline: "0.5rem",
    marginBottom: "0.5rem",
    maxHeight: "20rem",
    overflow: "auto",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-page)",
    paddingBlock: "0.25rem",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "1.4",
  },
  reopenDialogDiv: {
    marginTop: "1.25rem",
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
  },
});

const toneChoices1 = {
  added: styles.patchDivPrimary,
  removed: styles.patchDivSecondary,
  hunk: styles.patchDivTertiary,
  plain: styles.patchDivQuaternary,
};

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
          <p {...stylex.attrs(styles.closeIssueDialogP)}>
            {working()
              ? t("web.issue.close.working", { who: props.session?.name ?? props.issue.title })
              : acts().includes("complete")
                ? t("web.issue.close.completable", { who: props.session?.name ?? props.issue.title })
                : t("web.issue.close.notCompletable", { who: props.session?.name ?? props.issue.title })}
          </p>
          <div {...stylex.attrs(styles.closeIssueDialogDiv)}>
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
        <p {...stylex.attrs(styles.changesReviewP)}>{t("web.issue.changes.reading")}</p>
      </Match>
      <Match when={changes.error()}>
        {(error) => (
          <div>
            <Note tone="berry">
              <span {...stylex.attrs(styles.changesReviewSpan)}>
                {t("web.issue.changes.unreadable")}
                {reasonOf(error())}
              </span>
            </Note>
            <Button styles={styles.doneAction} onClick={() => props.onDone()}>
              {t("web.issue.later")}
            </Button>
          </div>
        )}
      </Match>
      <Match when={ready(changes, undefined)}>
        {(c) => {
          const empty = () => nothingChanged(c());
          return (
            <div {...stylex.attrs(styles.changesReviewDiv)}>
              <ChangesHead changes={c()} />
              <Show
                when={c().conflicts.length > 0}
                fallback={
                  <Show when={empty()}>
                    <Note>
                      <span {...stylex.attrs(styles.changesReviewSpan2)}>{t("web.issue.changes.none")}</span>
                    </Note>
                  </Show>
                }
              >
                <Note tone="berry">
                  <div {...stylex.attrs(styles.changesReviewDiv2)}>{t("web.issue.changes.conflict", { base: c().base })}</div>
                  <div {...stylex.attrs(styles.changesReviewDiv3)}>
                    <For each={c().conflicts}>{(f) => <span {...stylex.attrs(styles.changesReviewSpan3)}>{f}</span>}</For>
                  </div>
                  <div {...stylex.attrs(styles.changesReviewDiv4)}>{t("web.issue.changes.resolveHow", { base: c().base })}</div>
                </Note>
              </Show>
              <Show when={c().behind > 0 && c().conflicts.length === 0}>
                <p {...stylex.attrs(styles.changesReviewP2)}>{t("web.issue.changes.behind", { base: c().base, n: c().behind })}</p>
              </Show>
              <Show when={c().uncommitted.length > 0}>
                <Note tone="wheat">
                  <div>{t("web.issue.changes.uncommitted", { n: c().uncommitted.length })}</div>
                  <div {...stylex.attrs(styles.changesReviewDiv3)}>
                    <For each={c().uncommitted}>
                      {(f) => (
                        <span {...stylex.attrs(styles.changesReviewSpan4)}>
                          {changeKind(f.status).mark} {f.path}
                        </span>
                      )}
                    </For>
                  </div>
                </Note>
              </Show>
              <div {...stylex.attrs(styles.changesReviewDiv5)}>
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
                <p {...stylex.attrs(styles.changesReviewP2)}>{t("web.issue.changes.moved")}</p>
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
    <div {...stylex.attrs(styles.changesHeadDiv)}>
      <span {...stylex.attrs(styles.changesHeadSpan)}>
        {t("web.issue.task.repo")} {props.changes.repo}
      </span>
      <Show when={props.changes.branch}>
        <span {...stylex.attrs(styles.changesHeadSpan2)}>
          {props.changes.branch} → {props.changes.base}
        </span>
      </Show>
      <span {...stylex.attrs(styles.changesReviewP2)}>
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
          <h3 {...stylex.attrs(styles.changesBodyH3)}>{t("web.issue.changes.commits", { n: props.changes.commits.length })}</h3>
          <For each={props.changes.commits}>
            {(m) => (
              <div {...stylex.attrs(styles.changesBodyDiv)}>
                <span {...stylex.attrs(styles.changesBodySpan)}>{m.hash}</span>
                <span {...stylex.attrs(styles.changesBodySpan2)}>{m.subject}</span>
                <span {...stylex.attrs(styles.changesBodySpan3)}>{ago(m.at, now)}</span>
              </div>
            )}
          </For>
        </section>
      </Show>
      <Show when={props.changes.files.length > 0}>
        <section>
          <h3 {...stylex.attrs(styles.changesBodyH3)}>{t("web.issue.changes.files", { n: props.changes.files.length })}</h3>
          <div {...styleProps(changeStyles.files)}>
            <For each={props.changes.files}>{(f) => <FileRow file={f} conflict={props.changes.conflicts.includes(f.path)} />}</For>
          </div>
        </section>
      </Show>
    </>
  );
}

function PlusMinus(props: { added: number; removed: number }) {
  return (
    <span {...stylex.attrs(styles.changesHeadSpan2)}>
      <span {...stylex.attrs(styles.plusMinusSpan)}>+{props.added}</span> <span {...stylex.attrs(styles.changesReviewSpan)}>−{props.removed}</span>
    </span>
  );
}

const kindLook: Record<string, stylex.StyleXStyles> = { A: changeStyles.added, M: changeStyles.modified, D: changeStyles.deleted };

function FileRow(props: { file: ChangedFile; conflict: boolean }) {
  const [open, setOpen] = createSignal(false);
  const kind = () => changeKind(props.file.status);
  const hasPatch = () => !!props.file.patch;
  return (
    <div {...styleProps(changeStyles.file)}>
      <button
        type="button"
        data-testid="changed-file"
        data-key={props.file.path}
        disabled={!hasPatch()}
        aria-expanded={hasPatch() ? aria(open()) : undefined}
        onClick={() => setOpen(!open())}
        {...stylex.attrs(
          styles.fileRowButton,
          hasPatch()
            ? open()
              ? styles.fileRowButtonState4
              : styles.fileRowButtonState3
            : open()
              ? styles.fileRowButtonState2
              : styles.fileRowButtonState,
        )}
      >
        <span title={kind().label} {...styleProps([changeStyles.kind, kindLook[props.file.status] ?? changeStyles.unknown])}>
          {kind().mark}
        </span>
        <span
          title={props.file.path}
          {...stylex.attrs(styles.fileRowSpan, props.conflict ? styles.fileRowSpanTone : styles.fileRowSpanAlt)}
        >
          {props.file.path}
        </span>
        <Show when={props.conflict}>
          <span {...stylex.attrs(styles.fileRowSpan2)}>{t("web.issue.changes.conflictMark")}</span>
        </Show>
        <Show when={props.file.added >= 0} fallback={<span {...stylex.attrs(styles.changesBodySpan)}>{t("web.issue.changes.binary")}</span>}>
          <PlusMinus added={Math.round(props.file.added)} removed={Math.round(props.file.removed)} />
        </Show>
      </button>
      <Show when={open() ? props.file.patch : undefined}>{(patch) => <Patch text={patch()} path={props.file.path} />}</Show>
    </div>
  );
}

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
    <pre {...stylex.attrs(styles.patchPre)}>
      <For each={lines()}>
        {(line, i) => {
          const mark = patchMarkOf(line);
          const coloured = () => (mark === "hunk" ? undefined : tokens()?.[row(i())]);
          return (
            <div {...stylex.attrs(styles.patchDiv, toneChoices1[mark])}>
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
      <p {...stylex.attrs(styles.closeIssueDialogP)}>{t("web.issue.reopen.line", { issue: issueTitle(props.issue) })}</p>
      <TextArea
        ref={autofocus()}
        styles={styles.reopenDialogTextArea}
        rows={3}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        placeholder={t("web.issue.reopen.what")}
        aria-label={t("web.issue.reopen.whatLabel")}
      />
      <div {...stylex.attrs(styles.reopenDialogDiv)}>
        <Button onClick={() => props.onClose()}>{t("web.issue.never")}</Button>
        <Button tone="primary" onClick={() => reopen()}>
          {t("web.issue.reopen.reopen")}
        </Button>
      </div>
    </Dialog>
  );
}
