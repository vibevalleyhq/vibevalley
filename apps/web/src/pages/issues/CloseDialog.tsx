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

/** Closing an issue: harvest it (its checklist first) or let the helper go. `review` opens straight on the checklist. */
export function CloseIssueDialog(props: { issue: Issue; session: Session; review?: boolean; onClose: () => void }) {
  const [reviewing, setReviewing] = createSignal(untrack(() => props.review ?? false));
  const working = () => props.session.phase._tag === "working" || props.session.phase._tag === "arriving";
  const cancel = async () => {
    const id = props.issue.id;
    await run(() => api.issue.status({ id, body: { status: "canceled" } }));
    props.onClose();
  };
  return (
    <Dialog open onClose={props.onClose} title={`关上「${issueTitle(props.issue)}」`} wide={reviewing()}>
      <Show when={!reviewing()} fallback={<HarvestReview issue={props.issue.id} onDone={props.onClose} />}>
        <div>
          <p class="text-base">
            {working()
              ? `${props.session.name} 还在干这张工单。关上就是叫停它、让它收工，分支上的改动不合进主分支。`
              : `收获就是把 ${props.session.name} 的分支合进项目的主分支，先看一遍收成清单；不收就是让它收工，改动不合进去。`}
          </p>
          <div class="mt-5 flex flex-wrap gap-2">
            <Show when={!working()}>
              <Button tone="primary" onClick={() => setReviewing(true)}>
                看收成清单，收获
              </Button>
            </Show>
            <Button tone="danger" onClick={() => void cancel()}>
              {working() ? "叫停并收工" : "不收，直接收工"}
            </Button>
            <Button onClick={() => props.onClose()}>算了</Button>
          </div>
        </div>
      </Show>
    </Dialog>
  );
}

/** What the branch brings before it is merged. */
export function HarvestReview(props: { issue: string; onDone: () => void }) {
  const changes = useIssueChanges(() => props.issue);
  const take = () => {
    const id = props.issue;
    void run(() => api.issue.status({ id, body: { status: "done" } }));
    props.onDone();
  };
  const resolve = () => {
    const id = props.issue;
    void run(() => api.issue.act({ id, body: { act: "resolve" } }));
    props.onDone();
  };
  return (
    <Switch>
      <Match when={changes.isPending}>
        <p class="py-10 text-center text-sm text-muted">正在看它改了什么…</p>
      </Match>
      <Match when={changes.error}>
        {(error) => (
          <div>
            <Note tone="berry">
              <span class="text-berry">看不了改动：{reasonOf(error())}</span>
            </Note>
            <Button class="mt-4" onClick={() => props.onDone()}>
              先不收
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
                      <span class="text-muted">这一单没有改动。收获就是请它收工。</span>
                    </Note>
                  </Show>
                }
              >
                <Note tone="berry">
                  <div class="font-semibold text-berry">合进 {c().base} 会冲突，先没法收</div>
                  <div class="mt-1.5 flex flex-wrap gap-1">
                    <For each={c().conflicts}>{(f) => <span class="rounded bg-page px-1.5 font-mono text-xs text-berry">{f}</span>}</For>
                  </div>
                  <div class="mt-1.5 text-xs text-muted">让它在自己的分支上把 {c().base} 合进来、解决冲突、跑一遍测试再提交；做完再来收。</div>
                </Note>
              </Show>
              <Show when={c().behind > 0 && c().conflicts.length === 0}>
                <p class="text-xs text-muted">
                  它干活这段时间，{c().base} 上多了 {c().behind} 个提交；收获时会合在一起（多一个合并提交）。
                </p>
              </Show>
              <Show when={c().uncommitted.length > 0}>
                <Note tone="wheat">
                  <div>还有 {c().uncommitted.length} 个文件没提交，收获时会先帮它提交：</div>
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
                <Show
                  when={c().conflicts.length > 0}
                  fallback={
                    <Button tone="primary" onClick={take}>
                      {empty() ? "请它收工" : `确认收获，合进 ${c().base}`}
                    </Button>
                  }
                >
                  <Button tone="danger" onClick={resolve}>
                    让它解决冲突
                  </Button>
                </Show>
                <Button onClick={() => props.onDone()}>先不收</Button>
              </div>
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
      <span class="rounded bg-selected px-1.5 text-xs">项目 {props.changes.project}</span>
      <Show when={props.changes.branch}>
        <span class="font-mono text-xs">
          {props.changes.branch} → {props.changes.base}
        </span>
      </Show>
      <span class="text-xs text-muted">
        {props.changes.commits.length} 个提交 · {props.changes.files.length} 个文件
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
          <h3 class="mt-2 mb-1 text-xs font-semibold text-muted">提交 {props.changes.commits.length}</h3>
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
          <h3 class="mt-2 mb-1 text-xs font-semibold text-muted">改了的文件 {props.changes.files.length}</h3>
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
          <span class="rounded bg-berry/15 px-1.5 text-xs text-berry">冲突</span>
        </Show>
        <Show when={props.file.added >= 0} fallback={<span class="font-mono text-xs text-muted">二进制</span>}>
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
    <Dialog open onClose={props.onClose} title="重开这张工单">
      <p class="text-base">「{issueTitle(props.issue)}」由同一个帮工档案的新帮工接着做，它会知道这张工单原来要做什么、上一次是怎么关的。</p>
      <TextArea
        ref={autofocus()}
        class="mt-4"
        rows={3}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        placeholder="这次要它做什么（不填就是接着做完）"
        aria-label="这次要做什么"
      />
      <div class="mt-5 flex justify-end gap-2">
        <Button onClick={() => props.onClose()}>算了</Button>
        <Button tone="primary" onClick={() => void reopen()}>
          重开
        </Button>
      </div>
    </Dialog>
  );
}
