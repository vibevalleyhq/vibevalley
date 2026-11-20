// Ported from VibeValley apps/web/src/features/issue/views/CloseDialog.tsx:
// the close and reopen dialogs and the changes review. Not ported: the
// patch is nsh's DiffView (one column, + and - beside the lines, the code
// coloured by the file's language) in place of Shiki in a web worker; a
// patch DiffView cannot read (cut short) shows its lines tinted, uncoloured.
import { Scroll, signal, Text, View } from "nsh";
import { DiffView } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { ChangedFile, Changes, Issue, IssueAct, Session } from "@vibevalley/protocol";

import { hostApi } from "../../../../../bridge";
import { ago } from "../../../base/format";
import { reasonOf } from "../../../infra/api";
import { useCore } from "../../../infra/frame";
import { ready } from "../../../infra/query";
import { useIntents } from "../../../state/intent";
import { createAct } from "../../../ui/act";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { TextArea } from "../../../ui/Field";
import { Icon } from "../../../ui/Icon";
import { mix } from "../../../ui/tone";
import { actionOf, perform } from "../model/acts";
import { type Lane } from "../model/cards";
import { approveShownChanges, changeKind, lineCounts, nothingChanged, patchLines, patchMarkOf } from "../model/changes";
import { useIssueChanges } from "../model/history";
import { issueTitle } from "../model/issue";
import { issueMove, sendMove } from "../model/moves";
import { Note, SheetLabel } from "./Sheet";

/** Closing an issue: complete it (its changes first) or cancel it. `review` opens straight on the changes. */
export function CloseIssueDialog(props: { issue: Issue; session?: Session | undefined; review?: boolean; lane?: Lane | undefined; onClose: () => void }) {
  const reviewing = signal(props.review ?? false);
  const core = useCore();
  const live = () => core()?.issues.find((i) => i.id === props.issue.id);
  const acts = () => (live()?.stage.acts ?? []).map((a) => a.act);
  const working = () => acts().includes("stop");
  const presses = createPresses(() => props.lane);
  const cancel = async () => {
    if (await presses.press(live(), "close")) props.onClose();
  };
  const who = () => props.session?.name ?? props.issue.title;
  const canComplete = () => acts().includes("complete");
  const canClose = () => acts().includes("close");
  return (
    <Dialog open onClose={props.onClose} title={t("web.issue.close.title", { issue: issueTitle(props.issue) })} wide={reviewing()} testid="close-issue">
      <If when={!reviewing()} else={<ChangesReview issue={props.issue.id} worktree={props.session?.worktree} lane={props.lane} onDone={props.onClose} />}>
        <View class="gap-5">
          <Text class="text-sm leading-relaxed text-ink">
            {working()
              ? t("web.issue.close.working", { who: who() })
              : canComplete()
                ? t("web.issue.close.completable", { who: who() })
                : t("web.issue.close.notCompletable", { who: who() })}
          </Text>
          <View class="flex-row flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
            <Button tone="quiet" class={canComplete() && canClose() ? "mr-auto" : undefined} testID="close-never" onPress={() => props.onClose()}>
              {t("web.issue.never")}
            </Button>
            <If when={canClose()}>
              <Button tone="danger" testID="act-close" onPress={() => void cancel()}>
                {working() ? t("web.issue.close.stopAndCancel") : t("web.issue.close.cancel")}
              </Button>
            </If>
            <If when={canComplete()}>
              <Button tone="primary" testID="review-changes" onPress={() => reviewing.set(true)}>
                {t("web.issue.close.review")}
              </Button>
            </If>
          </View>
        </View>
      </If>
    </Dialog>
  );
}

/** The dialog's buttons. A move is an intent: the dialog closes once it is sent, and the board and the issue's page show it moving, or refused with a retry. */
function createPresses(lane: () => Lane | undefined) {
  const moves = useIntents(issueMove);
  const act = createAct();
  return {
    /** False when the issue does not offer it or the press did not go through. */
    press: async (issue: Issue | undefined, pressed: IssueAct, revision?: Changes["revision"]) => {
      const a = issue && actionOf(issue, pressed);
      if (!issue || !a) return false;
      if (a.does === "move") {
        // The lane it was dropped on is where closing puts it; a resolve sends it back to work instead.
        const to = pressed === "resolve" ? undefined : lane();
        void sendMove(moves, { id: issue.id, status: a.status, ...(revision ? { revision } : {}), ...(to ? { lane: to } : {}) });
        return true;
      }
      return (await act.run(async () => (await perform(issue, a), true))) === true;
    },
  };
}

/** What the branch brings before it is merged. */
function ChangesReview(props: { issue: string; worktree?: string | undefined; lane?: Lane | undefined; onDone: () => void }) {
  const sinceTree = signal<string | undefined>(undefined);
  const changes = useIssueChanges(
    () => props.issue,
    () => true,
    sinceTree,
  );
  const core = useCore();
  const live = () => core()?.issues.find((i) => i.id === props.issue);
  const acts = () => (live()?.stage.acts ?? []).map((a) => a.act);
  const presses = createPresses(() => props.lane);
  const reviewError = signal("");
  const review = createAct((message) => reviewError.set(message));
  const take = async (shown: Changes) => {
    const issue = live();
    if (!issue || review.busy()) return;
    reviewError.set("");
    const approved = await review.run(() => approveShownChanges(issue, shown));
    if (!approved) {
      if (shown.revision && sinceTree() !== shown.revision.tree) sinceTree.set(shown.revision.tree);
      else await changes.refetch();
      return;
    }
    if (await presses.press(issue, "complete", approved.revision)) props.onDone();
  };
  const resolve = async () => {
    if (await presses.press(live(), "resolve")) props.onDone();
  };
  return (
    <If
      when={changes.status() !== "pending"}
      else={
        <View class="flex-row items-center justify-center gap-2 py-10">
          <Icon name="wait" size={14} tone="muted" />
          <Text class="text-sm text-muted">{t("web.issue.changes.reading")}</Text>
        </View>
      }
    >
      <If
        when={changes.error() === undefined || changes.error() === null}
        else={
          <View class="gap-4">
            <Note tone="berry">
              <View class="flex-row items-start gap-2">
                <View class="mt-0.5 shrink-0">
                  <Icon name="cross" size={14} />
                </View>
                <Text class="min-w-0 flex-1 text-sm text-berry">
                  {t("web.issue.changes.unreadable")}
                  {reasonOf(changes.error())}
                </Text>
              </View>
            </Note>
            <View class="flex-row justify-end border-t border-line pt-3">
              <Button tone="quiet" onPress={() => props.onDone()}>
                {t("web.issue.later")}
              </Button>
            </View>
          </View>
        }
      >
        <If when={ready(changes, undefined)}>
          {(c) => (
            <View testID="changes-review" class="gap-3">
              <ChangesHead changes={c()} />
              <If when={reviewError()}>
                {(message) => (
                  <Note tone="wheat">
                    <View class="flex-row items-start gap-2">
                      <View class="mt-0.5 shrink-0">
                        <Icon name="warn" size={14} />
                      </View>
                      <Text class="min-w-0 flex-1 text-sm text-ink">{message()}</Text>
                    </View>
                  </Note>
                )}
              </If>
              <If
                when={c().conflicts.length > 0}
                else={
                  <If when={nothingChanged(c())}>
                    <Note>
                      <View class="flex-row items-center gap-2">
                        <Icon name="info" size={14} tone="muted" />
                        <Text class="min-w-0 flex-1 text-sm text-muted">{t("web.issue.changes.none")}</Text>
                      </View>
                    </Note>
                  </If>
                }
              >
                <Note tone="berry">
                  <View class="flex-row items-start gap-2">
                    <View class="mt-0.5 shrink-0">
                      <Icon name="cross" size={14} />
                    </View>
                    <View class="min-w-0 flex-1">
                      <Text class="text-sm font-semibold text-berry">{t("web.issue.changes.conflict", { base: c().base })}</Text>
                      <ConflictFiles files={c().conflicts} worktree={props.worktree} />
                      <Text class="mt-2 text-xs leading-relaxed text-muted">{t("web.issue.changes.resolveHow", { base: c().base })}</Text>
                    </View>
                  </View>
                </Note>
              </If>
              <If when={c().behind > 0 && c().conflicts.length === 0}>
                <View class="flex-row items-start gap-1.5 px-1">
                  <View class="mt-0.5 shrink-0">
                    <Icon name="info" size={12} tone="muted" />
                  </View>
                  <Text class="min-w-0 flex-1 text-xs text-muted tabular-nums">{t("web.issue.changes.behind", { base: c().base, n: c().behind })}</Text>
                </View>
              </If>
              <If when={c().uncommitted.length > 0}>
                <Note tone="wheat">
                  <View class="flex-row items-start gap-2">
                    <View class="mt-0.5 shrink-0">
                      <Icon name="warn" size={14} />
                    </View>
                    <View class="min-w-0 flex-1">
                      <Text class="text-sm font-medium text-ink tabular-nums">{t("web.issue.changes.uncommitted", { n: c().uncommitted.length })}</Text>
                      <View class="mt-2 flex-row flex-wrap gap-1.5">
                        <Each of={c().uncommitted}>
                          {(f) => {
                            const kind = () => changeKind(f().status);
                            const look = () => kindLook[f().status];
                            return (
                              <View class="flex-row items-center gap-1.5 rounded-sm border border-line bg-page px-1.5 py-0.5">
                                <View
                                  class={`h-4 min-w-4 items-center justify-center rounded-xs px-0.5 ${look() ? "" : "bg-selected"}`}
                                  style={look() ? { backgroundColor: look()?.bg() } : undefined}
                                >
                                  <Text class={`text-2xs font-semibold ${look()?.ink ?? "text-ink"}`}>{kind().mark}</Text>
                                </View>
                                <Text class="font-mono text-xs text-ink">{f().path}</Text>
                              </View>
                            );
                          }}
                        </Each>
                      </View>
                    </View>
                  </View>
                </Note>
              </If>
              <View class="flex-row flex-wrap items-center gap-2 border-b border-line pb-3">
                <If when={acts().includes("complete")}>
                  <Button tone="primary" testID="review-complete" disabled={review.busy()} onPress={() => void take(c())}>
                    {t("shared.act.complete")}
                  </Button>
                </If>
                <If when={acts().includes("resolve")}>
                  <Button tone="danger" testID="act-resolve" onPress={() => void resolve()}>
                    {t("web.issue.changes.resolve")}
                  </Button>
                </If>
                <Button tone="quiet" onPress={() => props.onDone()}>
                  {t("web.issue.later")}
                </Button>
              </View>
              <If when={!acts().includes("complete") && !acts().includes("resolve")}>
                <Text class="text-xs text-muted">{t("web.issue.changes.moved")}</Text>
              </If>
              <If when={c().sinceReview} else={<ChangesBody changes={c()} />}>
                {(files) => (
                  <View testID="changes-since-review">
                    <SheetLabel first>{t("web.issue.changes.sinceReview")}</SheetLabel>
                    <ChangesBody changes={{ ...c(), commits: [], files: files() }} />
                  </View>
                )}
              </If>
            </View>
          )}
        </If>
      </If>
    </If>
  );
}

export function ConflictFiles(props: { files: string[]; worktree?: string | undefined }) {
  const error = signal("");
  const open = async (worktree: string, path: string) => {
    const reply = await hostApi.openWorktreeFile(worktree, path);
    error.set(reply.bizCode === 0 ? "" : reply.message);
  };
  return (
    <View class="mt-2 gap-1.5">
      <View class="flex-row flex-wrap gap-1.5">
        <Each of={props.files}>
          {(path) => (
            <If
              when={props.worktree}
              else={
                <View class="rounded-sm bg-bad-soft px-1.5 py-0.5">
                  <Text class="font-mono text-xs text-berry">{path()}</Text>
                </View>
              }
            >
              {(worktree) => (
                <Button icon="file" testID="conflict-file" onPress={() => void open(worktree(), path())}>
                  <Text class="truncate font-mono text-xs text-ink">{path()}</Text>
                </Button>
              )}
            </If>
          )}
        </Each>
      </View>
      <If when={error()}>{(reason) => <Text class="text-xs text-berry">{reason()}</Text>}</If>
    </View>
  );
}

export function ChangesHead(props: { changes: Changes }) {
  const counts = () => lineCounts(props.changes);
  return (
    <View class="flex-row flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md bg-side px-3 py-2">
      <View class="flex-row items-center gap-1 rounded-sm bg-selected px-1.5 py-0.5">
        <Icon name="folder" size={12} tone="muted" />
        <Text class="text-xs font-medium text-ink">{props.changes.repo}</Text>
      </View>
      <If when={props.changes.branch}>
        <View class="min-w-0 flex-row items-center gap-1">
          <Text class="truncate font-mono text-xs font-medium text-ink">{props.changes.branch}</Text>
          <Text class="shrink-0 text-xs text-faint">→</Text>
          <Text class="shrink-0 font-mono text-xs text-muted">{props.changes.base}</Text>
        </View>
      </If>
      <View class="ml-auto flex-row items-center gap-2.5">
        <Text class="text-xs text-muted tabular-nums">
          {t("web.issue.changes.counts", { commits: props.changes.commits.length, files: props.changes.files.length })}
        </Text>
        <If when={props.changes.files.length > 0}>
          <PlusMinus added={counts()[0]} removed={counts()[1]} />
        </If>
      </View>
    </View>
  );
}

/** The commits and the files, each file opening to its patch. */
export function ChangesBody(props: { changes: Changes }) {
  const now = Date.now();
  const anyPatch = () => props.changes.files.some((f) => !!f.patch);
  return (
    <>
      <If when={props.changes.commits.length > 0}>
        <View>
          <Text role="header" class="mt-2 mb-1.5 text-xs font-semibold text-muted tabular-nums">
            {t("web.issue.changes.commits", { n: props.changes.commits.length })}
          </Text>
          <View class="overflow-hidden rounded-md border border-line">
            <Each of={props.changes.commits}>
              {(m, i) => (
                <View class={`flex-row items-center gap-2.5 px-2.5 py-1.5 ${i() === props.changes.commits.length - 1 ? "" : "border-b border-line"}`}>
                  <Text class="w-16 shrink-0 font-mono text-xs text-muted tabular-nums">{m().hash}</Text>
                  <Text class="min-w-0 flex-1 truncate text-sm text-ink">{m().subject}</Text>
                  <Text class="shrink-0 text-right text-xs text-faint tabular-nums">{ago(m().at, now)}</Text>
                </View>
              )}
            </Each>
          </View>
        </View>
      </If>
      <If when={props.changes.files.length > 0}>
        <View>
          <Text role="header" class="mt-2.5 mb-1.5 text-xs font-semibold text-muted tabular-nums">
            {t("web.issue.changes.files", { n: props.changes.files.length })}
          </Text>
          <View class="overflow-hidden rounded-md border border-line">
            <Each of={props.changes.files}>
              {(f, i) => (
                <FileRow
                  file={f()}
                  last={i() === props.changes.files.length - 1}
                  conflict={props.changes.conflicts.includes(f().path)}
                  reserveChevron={anyPatch()}
                />
              )}
            </Each>
          </View>
        </View>
      </If>
    </>
  );
}

function PlusMinus(props: { added: number; removed: number; aligned?: boolean }) {
  const numClass = () =>
    props.aligned === true ? "min-w-8 text-right font-mono text-xs font-medium tabular-nums" : "font-mono text-xs font-medium tabular-nums";
  return (
    <View class="shrink-0 flex-row items-center gap-1.5">
      <Text class={`${numClass()} ${props.added > 0 ? "text-accent" : "text-faint"}`}>{`+${props.added}`}</Text>
      <Text class={`${numClass()} ${props.removed > 0 ? "text-berry" : "text-faint"}`}>{`−${props.removed}`}</Text>
    </View>
  );
}

const kindLook: Record<string, { bg: () => string; ink: string }> = {
  A: { bg: () => mix("ok-soft", 1), ink: "text-ok-ink" },
  M: { bg: () => mix("wheat", 0.22), ink: "text-warn-ink" },
  D: { bg: () => mix("bad-soft", 1), ink: "text-berry" },
};

function FileRow(props: { file: ChangedFile; conflict: boolean; last: boolean; reserveChevron: boolean }) {
  const open = signal(false);
  const kind = () => changeKind(props.file.status);
  const hasPatch = () => !!props.file.patch;
  const look = () => kindLook[props.file.status];
  return (
    <View class={props.last ? "" : "border-b border-line"}>
      <View
        role="button"
        testID="changed-file"
        accessibilityLabel={props.file.path}
        accessibilityState={hasPatch() ? { expanded: open() } : undefined}
        disabled={!hasPatch()}
        onPress={() => open.set(!open())}
        class={`min-h-8 w-full flex-row items-center gap-2 px-2.5 py-1.5 transition duration-120 ease-out ${open() ? "bg-side hover:bg-hover" : hasPatch() ? "hover:bg-hover" : ""}`}
      >
        <If when={props.reserveChevron}>
          <View
            class="size-3.5 shrink-0 items-center justify-center transition-transform duration-120 ease-out"
            style={hasPatch() ? { transform: [{ rotate: open() ? "90deg" : "0deg" }] } : undefined}
          >
            <If when={hasPatch()}>
              <Icon name="expand" size={10} tone={open() ? "ink" : "muted"} />
            </If>
          </View>
        </If>
        <View
          accessibilityLabel={kind().label}
          class={`h-5 w-5 shrink-0 items-center justify-center rounded-sm ${look() ? "" : "bg-selected"}`}
          style={look() ? { backgroundColor: look()?.bg() } : undefined}
        >
          <Text class={`text-2xs font-semibold ${look()?.ink ?? "text-ink"}`}>{kind().mark}</Text>
        </View>
        <Text class={`min-w-0 flex-1 truncate font-mono text-xs ${props.conflict ? "text-berry" : "text-ink"}`}>{props.file.path}</Text>
        <If when={props.conflict}>
          <View class="shrink-0 rounded-sm bg-bad-soft px-1.5 py-px">
            <Text class="text-2xs font-medium text-berry">{t("web.issue.changes.conflictMark")}</Text>
          </View>
        </If>
        <If when={props.file.added >= 0} else={<Text class="shrink-0 font-mono text-xs text-muted">{t("web.issue.changes.binary")}</Text>}>
          <PlusMinus added={Math.round(props.file.added)} removed={Math.round(props.file.removed)} aligned />
        </If>
      </View>
      <If when={open() ? props.file.patch : undefined}>{(patch) => <Patch text={patch()} path={props.file.path} />}</If>
    </View>
  );
}

const patchTone: Record<ReturnType<typeof patchMarkOf>, { bg?: () => string; ink: string }> = {
  added: { bg: () => mix("leaf", 0.2), ink: "text-accent" },
  removed: { bg: () => mix("berry", 0.1), ink: "text-berry" },
  hunk: { ink: "text-water" },
  plain: { ink: "text-ink" },
};

/** Every hunk has the lines its header counts: what DiffView can read. */
export function wellFormed(patch: string): boolean {
  let old = 0;
  let neu = 0;
  let hunks = 0;
  for (const line of patch.replace(/\n$/u, "").split("\n")) {
    const head = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(line);
    if (head) {
      if (old !== 0 || neu !== 0) return false;
      old = Number(head[1] ?? 1);
      neu = Number(head[2] ?? 1);
      hunks++;
    } else if (hunks === 0 || line.startsWith("\\")) continue;
    else if (line.startsWith("+")) neu--;
    else if (line.startsWith("-")) old--;
    else {
      old--;
      neu--;
    }
    if (old < 0 || neu < 0) return false;
  }
  return hunks > 0 && old === 0 && neu === 0;
}

/** A file's patch: each line marked added or removed, its code coloured as the file's language. */
function Patch(props: { text: string; path: string }) {
  // DiffView scrolls itself and does not grow with its lines: it is given their height (a hunk's longer side and its
  // header, as it pairs the lines), up to the box's; past that it scrolls inside.
  const height = () => {
    const lines = props.text.replace(/\n$/u, "").split("\n");
    const side = (mark: string) => lines.filter((l) => l.startsWith(mark) || l.startsWith(" ") || l === "").length;
    const hunks = lines.filter((l) => l.startsWith("@@")).length;
    return Math.min(320, (Math.max(side("+"), side("-")) + hunks) * 17 + 8);
  };
  return (
    <If
      when={wellFormed(props.text)}
      else={
        <Scroll testID="patch" class="border-t border-line bg-page py-1" style={{ maxHeight: 320 }}>
          <TintedLines text={props.text} />
        </Scroll>
      }
    >
      <View testID="patch" class="overflow-hidden border-t border-line bg-page py-1">
        <DiffView
          patch={props.text}
          language={props.path}
          layout="unified"
          indicators="classic"
          inline="none"
          lineNumbers={false}
          expandAll
          fontSize={12}
          lineHeight={17}
          style={{ height: height() }}
          classes={{ lineAdded: "bg-transparent", lineDeleted: "bg-transparent", separator: "bg-hover text-water" }}
          styles={{ lineAdded: { backgroundColor: mix("leaf", 0.2) }, lineDeleted: { backgroundColor: mix("berry", 0.1) } }}
        />
      </View>
    </If>
  );
}

function TintedLines(props: { text: string }) {
  return (
    <Each of={patchLines(props.text)}>
      {(line) => {
        const look = patchTone[patchMarkOf(line())];
        return (
          <View class="px-2.5" style={look.bg ? { backgroundColor: look.bg() } : undefined}>
            <Text class={`font-mono text-xs ${look.ink}`} style={{ lineHeight: 17 }}>
              {line() || " "}
            </Text>
          </View>
        );
      }}
    </Each>
  );
}

/** Reopening a closed issue: a new helper of the same profile goes on with it. */
export function ReopenDialog(props: { issue: Issue; lane?: Lane | undefined; onClose: () => void; onReopened: () => void }) {
  const text = signal("");
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
    <Dialog open onClose={props.onClose} title={t("web.issue.reopen.title")} testid="reopen-issue">
      <View class="gap-3.5">
        <Text class="text-sm leading-relaxed text-ink">{t("web.issue.reopen.line", { issue: issueTitle(props.issue) })}</Text>
        <TextArea
          autoFocus
          rows={3}
          value={text()}
          onInput={(v) => text.set(v)}
          placeholder={t("web.issue.reopen.what")}
          accessibilityLabel={t("web.issue.reopen.whatLabel")}
        />
        <View class="flex-row items-center justify-end gap-2 border-t border-line pt-3">
          <Button tone="quiet" onPress={() => props.onClose()}>
            {t("web.issue.never")}
          </Button>
          <Button tone="primary" testID="reopen" onPress={() => reopen()}>
            {t("web.issue.reopen.reopen")}
          </Button>
        </View>
      </View>
    </Dialog>
  );
}
