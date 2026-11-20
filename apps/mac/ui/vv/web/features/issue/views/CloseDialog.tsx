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
  return (
    <Dialog open onClose={props.onClose} title={t("web.issue.close.title", { issue: issueTitle(props.issue) })} wide={reviewing()} testid="close-issue">
      <If when={!reviewing()} else={<ChangesReview issue={props.issue.id} worktree={props.session?.worktree} lane={props.lane} onDone={props.onClose} />}>
        <View>
          <Text class="text-base text-ink">
            {working()
              ? t("web.issue.close.working", { who: who() })
              : acts().includes("complete")
                ? t("web.issue.close.completable", { who: who() })
                : t("web.issue.close.notCompletable", { who: who() })}
          </Text>
          <View class="mt-5 flex-row flex-wrap gap-2">
            <If when={acts().includes("complete")}>
              <Button tone="primary" testID="review-changes" onPress={() => reviewing.set(true)}>
                {t("web.issue.close.review")}
              </Button>
            </If>
            <If when={acts().includes("close")}>
              <Button tone="danger" testID="act-close" onPress={() => void cancel()}>
                {working() ? t("web.issue.close.stopAndCancel") : t("web.issue.close.cancel")}
              </Button>
            </If>
            <Button testID="close-never" onPress={() => props.onClose()}>
              {t("web.issue.never")}
            </Button>
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
    <If when={changes.status() !== "pending"} else={<Text class="py-10 text-center text-sm text-muted">{t("web.issue.changes.reading")}</Text>}>
      <If
        when={changes.error() === undefined || changes.error() === null}
        else={
          <View>
            <Note tone="berry">
              <Text class="text-sm text-berry">
                {t("web.issue.changes.unreadable")}
                {reasonOf(changes.error())}
              </Text>
            </Note>
            <Button class="mt-4 self-start" onPress={() => props.onDone()}>
              {t("web.issue.later")}
            </Button>
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
                    <Text class="text-sm text-ink">{message()}</Text>
                  </Note>
                )}
              </If>
              <If
                when={c().conflicts.length > 0}
                else={
                  <If when={nothingChanged(c())}>
                    <Note>
                      <Text class="text-sm text-muted">{t("web.issue.changes.none")}</Text>
                    </Note>
                  </If>
                }
              >
                <Note tone="berry">
                  <Text class="text-sm font-semibold text-berry">{t("web.issue.changes.conflict", { base: c().base })}</Text>
                  <ConflictFiles files={c().conflicts} worktree={props.worktree} />
                  <Text class="mt-1.5 text-xs text-muted">{t("web.issue.changes.resolveHow", { base: c().base })}</Text>
                </Note>
              </If>
              <If when={c().behind > 0 && c().conflicts.length === 0}>
                <Text class="text-xs text-muted">{t("web.issue.changes.behind", { base: c().base, n: c().behind })}</Text>
              </If>
              <If when={c().uncommitted.length > 0}>
                <Note tone="wheat">
                  <Text class="text-sm text-ink">{t("web.issue.changes.uncommitted", { n: c().uncommitted.length })}</Text>
                  <View class="mt-1.5 flex-row flex-wrap gap-1">
                    <Each of={c().uncommitted}>
                      {(f) => (
                        <View class="rounded-sm bg-page px-1.5 py-0.5">
                          <Text class="font-mono text-xs text-ink">{`${changeKind(f().status).mark} ${f().path}`}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </Note>
              </If>
              <View class="flex-row flex-wrap gap-2">
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
                <Button onPress={() => props.onDone()}>{t("web.issue.later")}</Button>
              </View>
              <If when={!acts().includes("complete") && !acts().includes("resolve")}>
                <Text class="text-xs text-muted">{t("web.issue.changes.moved")}</Text>
              </If>
              <If when={c().sinceReview} else={<ChangesBody changes={c()} />}>
                {(files) => (
                  <View testID="changes-since-review">
                    <SheetLabel>{t("web.issue.changes.sinceReview")}</SheetLabel>
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
    <View class="mt-1.5 gap-1">
      <View class="flex-row flex-wrap gap-1">
        <Each of={props.files}>
          {(path) => (
            <If when={props.worktree} else={<Text class="font-mono text-xs text-berry">{path()}</Text>}>
              {(worktree) => (
                <Button testID="conflict-file" onPress={() => void open(worktree(), path())}>
                  {path()}
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
    <View class="flex-row flex-wrap items-center gap-2">
      <View class="rounded-sm bg-selected px-1.5">
        <Text class="text-xs text-ink">{`${t("web.issue.task.repo")} ${props.changes.repo}`}</Text>
      </View>
      <If when={props.changes.branch}>
        <Text class="font-mono text-xs text-ink">{`${props.changes.branch} → ${props.changes.base}`}</Text>
      </If>
      <Text class="text-xs text-muted">{t("web.issue.changes.counts", { commits: props.changes.commits.length, files: props.changes.files.length })}</Text>
      <If when={props.changes.files.length > 0}>
        <PlusMinus added={counts()[0]} removed={counts()[1]} />
      </If>
    </View>
  );
}

/** The commits and the files, each file opening to its patch. */
export function ChangesBody(props: { changes: Changes }) {
  const now = Date.now();
  return (
    <>
      <If when={props.changes.commits.length > 0}>
        <View>
          <Text role="header" class="mt-2 mb-1 text-xs font-semibold text-muted">
            {t("web.issue.changes.commits", { n: props.changes.commits.length })}
          </Text>
          <Each of={props.changes.commits}>
            {(m) => (
              <View class="flex-row items-center gap-2.5 py-0.5">
                <Text class="font-mono text-xs text-muted">{m().hash}</Text>
                <Text class="min-w-0 flex-1 truncate text-sm text-ink">{m().subject}</Text>
                <Text class="text-xs text-faint">{ago(m().at, now)}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={props.changes.files.length > 0}>
        <View>
          <Text role="header" class="mt-2 mb-1 text-xs font-semibold text-muted">
            {t("web.issue.changes.files", { n: props.changes.files.length })}
          </Text>
          <View class="overflow-hidden rounded-md border border-line">
            <Each of={props.changes.files}>
              {(f, i) => <FileRow file={f()} last={i() === props.changes.files.length - 1} conflict={props.changes.conflicts.includes(f().path)} />}
            </Each>
          </View>
        </View>
      </If>
    </>
  );
}

function PlusMinus(props: { added: number; removed: number }) {
  return (
    <Text class="font-mono text-xs">
      <Text class="text-accent">{`+${props.added}`}</Text> <Text class="text-berry">{`−${props.removed}`}</Text>
    </Text>
  );
}

const kindLook: Record<string, { bg: () => string; ink: string } | undefined> = {
  A: { bg: () => mix("leaf", 0.2), ink: "text-accent" },
  M: { bg: () => mix("wheat", 0.2), ink: "text-bark" },
  D: { bg: () => mix("berry", 0.15), ink: "text-berry" },
};

function FileRow(props: { file: ChangedFile; conflict: boolean; last: boolean }) {
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
        class={`w-full flex-row items-center gap-2.5 px-2.5 py-1.5 ${open() ? "bg-hover" : hasPatch() ? "hover:bg-hover" : ""}`}
      >
        <View
          accessibilityLabel={kind().label}
          class={`h-5 w-5 shrink-0 items-center justify-center rounded-sm ${look() ? "" : "bg-selected"}`}
          style={look() ? { backgroundColor: look()?.bg() } : undefined}
        >
          <Text class={`text-xs font-semibold ${look()?.ink ?? "text-ink"}`}>{kind().mark}</Text>
        </View>
        <Text class={`min-w-0 flex-1 truncate font-mono text-xs ${props.conflict ? "text-berry" : "text-ink"}`}>{props.file.path}</Text>
        <If when={props.conflict}>
          <View class="rounded-sm px-1.5" style={{ backgroundColor: mix("berry", 0.15) }}>
            <Text class="text-xs text-berry">{t("web.issue.changes.conflictMark")}</Text>
          </View>
        </If>
        <If when={props.file.added >= 0} else={<Text class="font-mono text-xs text-muted">{t("web.issue.changes.binary")}</Text>}>
          <PlusMinus added={Math.round(props.file.added)} removed={Math.round(props.file.removed)} />
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
        <Scroll testID="patch" class="mx-2 mb-2 max-h-80 rounded-md bg-page py-1">
          <TintedLines text={props.text} />
        </Scroll>
      }
    >
      <View testID="patch" class="mx-2 mb-2 overflow-hidden rounded-md bg-page py-1">
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
          <View class="px-2" style={look.bg ? { backgroundColor: look.bg() } : undefined}>
            <Text class={`font-mono text-xs leading-[17px] ${look.ink}`}>{line() || " "}</Text>
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
      <Text class="text-base text-ink">{t("web.issue.reopen.line", { issue: issueTitle(props.issue) })}</Text>
      <TextArea
        autoFocus
        class="mt-4"
        rows={3}
        value={text()}
        onInput={(v) => text.set(v)}
        placeholder={t("web.issue.reopen.what")}
        accessibilityLabel={t("web.issue.reopen.whatLabel")}
      />
      <View class="mt-5 flex-row justify-end gap-2">
        <Button onPress={() => props.onClose()}>{t("web.issue.never")}</Button>
        <Button tone="primary" testID="reopen" onPress={() => reopen()}>
          {t("web.issue.reopen.reopen")}
        </Button>
      </View>
    </Dialog>
  );
}
