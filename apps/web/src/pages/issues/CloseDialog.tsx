import { issuesWording } from "./words";
import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import type { ChangedFile, Changes, Issue, Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { issueTitle } from "../../rules/issues";
import { changeKind, lineCounts, nothingChanged, patchLines, patchMarkOf } from "../../rules/issueState";
import { ago } from "../../rules/time";
import { aria, autofocus } from "../../app/util";
import { ready } from "../../data/query";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TextArea } from "../../ui/Field";
import { run } from "./hooks";
import { Note } from "./Sheet";
import { useIssueChanges } from "../../data/issues";
import { useCore } from "../../data/frame";

/** Closing an issue: complete it (its changes first) or cancel it. `review` opens straight on the changes. */
export function CloseIssueDialog(props: { issue: Issue; session: Session; review?: boolean; onClose: () => void }) {
  const [reviewing, setReviewing] = createSignal(untrack(() => props.review ?? false));
  const core = useCore();
  const acts = () => core()?.issues?.find((i) => i.id === props.issue.id)?.attention.acts ?? [];
  const working = () => acts().includes("stop");
  const cancel = async () => {
    if (!acts().includes("close")) return;
    const id = props.issue.id;
    const closed = await run(() => api.issue.act({ id, body: { act: "close" } }));
    if (closed) props.onClose();
  };
  return (
    <Dialog open onClose={props.onClose} title={issuesWording().close.title(issueTitle(props.issue))} wide={reviewing()}>
      <Show when={!reviewing()} fallback={<ChangesReview issue={props.issue.id} onDone={props.onClose} />}>
        <div>
          <p class="text-base">
            {working()
              ? issuesWording().close.working(props.session.name)
              : acts().includes("complete")
                ? issuesWording().close.completable(props.session.name)
                : issuesWording().close.notCompletable(props.session.name)}
          </p>
          <div class="mt-5 flex flex-wrap gap-2">
            <Show when={acts().includes("complete")}>
              <Button tone="primary" onClick={() => setReviewing(true)}>
                {issuesWording().close.review}
              </Button>
            </Show>
            <Show when={acts().includes("close")}>
              <Button tone="danger" onClick={() => void cancel()}>
                {working() ? issuesWording().close.stopAndCancel : issuesWording().close.cancel}
              </Button>
            </Show>
            <Button onClick={() => props.onClose()}>{issuesWording().never}</Button>
          </div>
        </div>
      </Show>
    </Dialog>
  );
}

/** What the branch brings before it is merged. */
export function ChangesReview(props: { issue: string; onDone: () => void }) {
  const changes = useIssueChanges(() => props.issue);
  const core = useCore();
  const acts = () => core()?.issues?.find((i) => i.id === props.issue)?.attention.acts ?? [];
  const take = async () => {
    if (!acts().includes("complete")) return;
    const id = props.issue;
    const completed = await run(() => api.issue.act({ id, body: { act: "complete" } }));
    if (completed) props.onDone();
  };
  const resolve = async () => {
    if (!acts().includes("resolve")) return;
    const id = props.issue;
    const resolving = await run(() => api.issue.act({ id, body: { act: "resolve" } }));
    if (resolving) props.onDone();
  };
  return (
    <Switch>
      <Match when={changes.isPending}>
        <p class="py-10 text-center text-sm text-muted">{issuesWording().changes.reading}</p>
      </Match>
      <Match when={changes.error}>
        {(error) => (
          <div>
            <Note tone="berry">
              <span class="text-berry">
                {issuesWording().changes.unreadable}
                {reasonOf(error())}
              </span>
            </Note>
            <Button class="mt-4" onClick={() => props.onDone()}>
              {issuesWording().later}
            </Button>
          </div>
        )}
      </Match>
      <Match when={ready(changes, undefined)}>
        {(c) => {
          const empty = () => nothingChanged(c());
          return (
            <div class="flex flex-col gap-3">
              <ChangesHead changes={c()} />
              <Show
                when={c().conflicts.length > 0}
                fallback={
                  <Show when={empty()}>
                    <Note>
                      <span class="text-muted">{issuesWording().changes.none}</span>
                    </Note>
                  </Show>
                }
              >
                <Note tone="berry">
                  <div class="font-semibold text-berry">{issuesWording().changes.conflict(c().base)}</div>
                  <div class="mt-1.5 flex flex-wrap gap-1">
                    <For each={c().conflicts}>{(f) => <span class="rounded bg-page px-1.5 font-mono text-xs text-berry">{f}</span>}</For>
                  </div>
                  <div class="mt-1.5 text-xs text-muted">{issuesWording().changes.resolveHow(c().base)}</div>
                </Note>
              </Show>
              <Show when={c().behind > 0 && c().conflicts.length === 0}>
                <p class="text-xs text-muted">{issuesWording().changes.behind(c().base, c().behind)}</p>
              </Show>
              <Show when={c().uncommitted.length > 0}>
                <Note tone="wheat">
                  <div>{issuesWording().changes.uncommitted(c().uncommitted.length)}</div>
                  <div class="mt-1.5 flex flex-wrap gap-1">
                    <For each={c().uncommitted}>
                      {(f) => (
                        <span class="rounded bg-page px-1.5 py-0.5 font-mono text-xs">
                          {changeKind(f.status).mark} {f.path}
                        </span>
                      )}
                    </For>
                  </div>
                </Note>
              </Show>
              <div class="flex flex-wrap gap-2">
                <Show when={acts().includes("complete")}>
                  <Button tone="primary" onClick={() => void take()}>
                    {empty() ? issuesWording().changes.letGo : issuesWording().changes.merge(c().base)}
                  </Button>
                </Show>
                <Show when={acts().includes("resolve")}>
                  <Button tone="danger" onClick={() => void resolve()}>
                    {issuesWording().changes.resolve}
                  </Button>
                </Show>
                <Button onClick={() => props.onDone()}>{issuesWording().later}</Button>
              </div>
              <Show when={!acts().includes("complete") && !acts().includes("resolve")}>
                <p class="text-xs text-muted">{issuesWording().changes.moved}</p>
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
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="rounded bg-selected px-1.5 text-xs">
        {issuesWording().task.project} {props.changes.project}
      </span>
      <Show when={props.changes.branch}>
        <span class="font-mono text-xs">
          {props.changes.branch} → {props.changes.base}
        </span>
      </Show>
      <span class="text-xs text-muted">{issuesWording().changes.counts(props.changes.commits.length, props.changes.files.length)}</span>
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
          <h3 class="mt-2 mb-1 text-xs font-semibold text-muted">{issuesWording().changes.commits(props.changes.commits.length)}</h3>
          <For each={props.changes.commits}>
            {(m) => (
              <div class="flex items-center gap-2.5 py-0.5">
                <span class="font-mono text-xs text-muted">{m.hash}</span>
                <span class="min-w-0 flex-1 truncate text-sm">{m.subject}</span>
                <span class="text-xs text-faint">{ago(m.at, now)}</span>
              </div>
            )}
          </For>
        </section>
      </Show>
      <Show when={props.changes.files.length > 0}>
        <section>
          <h3 class="mt-2 mb-1 text-xs font-semibold text-muted">{issuesWording().changes.files(props.changes.files.length)}</h3>
          <div class="divide-y divide-line overflow-hidden rounded-md border border-line">
            <For each={props.changes.files}>{(f) => <FileRow file={f} conflict={props.changes.conflicts.includes(f.path)} />}</For>
          </div>
        </section>
      </Show>
    </>
  );
}

export function PlusMinus(props: { added: number; removed: number }) {
  return (
    <span class="font-mono text-xs">
      <span class="text-accent">+{props.added}</span> <span class="text-berry">−{props.removed}</span>
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
          <span class="rounded bg-berry/15 px-1.5 text-xs text-berry">{issuesWording().changes.conflictMark}</span>
        </Show>
        <Show when={props.file.added >= 0} fallback={<span class="font-mono text-xs text-muted">{issuesWording().changes.binary}</span>}>
          <PlusMinus added={Math.round(props.file.added)} removed={Math.round(props.file.removed)} />
        </Show>
      </button>
      <Show when={open() ? props.file.patch : undefined}>{(patch) => <Patch text={patch()} />}</Show>
    </div>
  );
}

const patchLook = { added: "bg-leaf/20 text-accent", removed: "bg-berry/10 text-berry", hunk: "text-water", plain: "" } as const;

function Patch(props: { text: string }) {
  return (
    <pre class="mx-2 mb-2 max-h-80 overflow-auto rounded-md border border-line bg-page py-1 font-mono text-xs leading-[1.4]">
      <For each={patchLines(props.text)}>{(line) => <div class={["px-2", patchLook[patchMarkOf(line)]]}>{line || " "}</div>}</For>
    </pre>
  );
}

/** Reopening a closed issue: a new helper of the same profile goes on with it. */
export function ReopenDialog(props: { issue: Issue; onClose: () => void; onReopened: () => void }) {
  const [text, setText] = createSignal("");
  const reopen = async () => {
    const id = props.issue.id;
    const words = text().trim();
    const got = await run(() => api.issue.status({ id, body: { status: "todo", text: words } }));
    props.onClose();
    if (got) props.onReopened();
  };
  return (
    <Dialog open onClose={props.onClose} title={issuesWording().reopen.title}>
      <p class="text-base">{issuesWording().reopen.line(issueTitle(props.issue))}</p>
      <TextArea
        ref={autofocus()}
        class="mt-4"
        rows={3}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        placeholder={issuesWording().reopen.what}
        aria-label={issuesWording().reopen.whatLabel}
      />
      <div class="mt-5 flex justify-end gap-2">
        <Button onClick={() => props.onClose()}>{issuesWording().never}</Button>
        <Button tone="primary" onClick={() => void reopen()}>
          {issuesWording().reopen.reopen}
        </Button>
      </div>
    </Dialog>
  );
}
