import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useQuery } from "@tanstack/solid-query";
import type { Acceptance, Issue, Session, SessionEvent } from "@vibevalley/protocol";
import { api } from "../../data/api";
import { newSendKey } from "./write";
import type { Tone } from "../../rules/cards";
import { type IssueTag, issueTag, runText, stageOf, tagLabel, tagOpen } from "../../rules/issues";
import { actLabel, bugText, changesLine, findingsOf, type IssueOffer, issueState, noStepsText, resumeWords } from "../../rules/issueState";
import { tookText, wallClockText } from "../../rules/time";
import { toast } from "../../ui/toasts";
import { ready, useAgents } from "../../data/query";
import { Button } from "../../ui/Button";
import { TextArea } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { ChangesBody, ChangesHead } from "./CloseDialog";
import { run, useGraphs } from "./hooks";
import { Fold, IssueSheet, More, Note, Pick, Property, Stages } from "./Sheet";

export const tagTone: Record<IssueTag, Tone> = {
  working: "water",
  waiting: "wheat",
  harvested: "leaf",
  merged: "leaf",
  answered: "leaf",
  dropped: "faint",
  closed: "faint",
  lost: "berry",
};

function Dot(props: { tone: Tone }) {
  return <span class="size-2 shrink-0 rounded-full" style={{ background: `var(--color-${props.tone})` }} />;
}

/** The workbench's issue page: the status and what it needs first, the rest folded. `onClose` opens the close dialog
 * (`review`: straight on the harvest checklist). */
export function IssueDetail(props: {
  issue: Issue;
  sessions: Session[];
  tag: IssueTag;
  session?: Session;
  onClose: (session: Session, review: boolean) => void;
  onTask?: () => void;
}) {
  const graphs = useGraphs();
  const s = createMemo(() => issueState(props.issue, props.sessions, props.tag, props.session, graphs()));
  const head = () => s().head;
  const [busy, setBusy] = createSignal(false);
  const [text, setText] = createSignal("");
  const agents = useAgents();
  const agent = () => ready(agents, []).find((a) => a.id === head().agent);
  const stepsQuery = useQuery(() => ({
    queryKey: ["issues", "events", head().id, head().runs, head().phase._tag],
    queryFn: () => api.session.events({ id: head().id }),
    placeholderData: (prev: SessionEvent[] | undefined) => prev,
  }));
  const steps = () => ready(stepsQuery, undefined);
  const changesQuery = useQuery(() => ({
    queryKey: ["issues", "changes", props.issue.id],
    queryFn: () => api.issue.changes({ id: props.issue.id }),
    enabled: s().showsChanges,
  }));
  const changes = () => ready(changesQuery, undefined);

  async function act(f: () => Promise<unknown>) {
    setBusy(true);
    const done = await run(async () => {
      await f();
      return true;
    });
    setBusy(false);
    return done;
  }

  const tell = () => {
    const words = text().trim();
    const id = props.issue.id;
    if (!words || !props.session) return;
    void act(() => api.issue.comment({ id, body: { text: words, sendKey: newSendKey() } })).then((ok) => ok && setText(""));
  };

  const reopen = async () => {
    const id = props.issue.id;
    const words = text().trim();
    setBusy(true);
    const got = await run(() => api.issue.status({ id, body: { status: "todo", text: words } }));
    setBusy(false);
    const last = got?.sessions[got.sessions.length - 1];
    if (last) {
      setText("");
      toast(`工单重开了：${last} 接着做。`);
    }
  };

  // A pass, or a fail whose findings are what the box says: one weed a line.
  const accept = async (pass: boolean) => {
    const id = props.issue.id;
    if (pass) return void act(() => api.issue.accept({ id, body: { pass: true } }));
    const lines = findingsOf(text());
    if (lines.length === 0) return;
    if (await act(() => api.issue.accept({ id, body: { pass: false, findings: lines } }))) setText("");
  };

  const offer = (o: IssueOffer, h: Session) => {
    const id = props.issue.id;
    const go = {
      stop: () => act(() => api.session.stop({ id: h.id })),
      resolve: () => act(() => api.issue.resolve({ id })),
      resume: () => act(() => api.issue.comment({ id, body: { text: resumeWords } })),
      harvest: () => props.onClose(h, true),
      cure: () => act(() => api.issue.comment({ id, body: { text: bugText(h.brief) } })),
      close: () => props.onClose(h, false),
    }[o.act];
    // Only the lead is filled; 关上 asks again in its own dialog, so it need not shout here.
    return (
      <Button tone={o.lead ? "primary" : "plain"} disabled={busy()} onClick={() => void go()} class="justify-center">
        {actLabel[o.act]}
      </Button>
    );
  };

  const parent = () => graphs().find((g) => g.id === props.issue.parent);
  const heading = (
    <div>
      <div class="mb-4 pr-10">
        <Stages at={stageOf(props.issue.status)} />
      </div>
      <Show when={s().inTask ? props.onTask : undefined}>
        {(onTask) => (
          <button type="button" onClick={() => onTask()()} class="mb-1.5 cursor-pointer px-2 text-xs text-water hover:underline">
            ‹ {parent()?.title ? `计划「${parent()!.title}」的一步` : "回到计划"}
          </button>
        )}
      </Show>
      <h1 class="px-2 text-xl font-semibold">{s().title}</h1>
      <Show when={s().description && s().description !== s().title}>
        <Markdown class="mt-2 px-2 text-sm text-ink/90" text={s().description!} />
      </Show>
    </div>
  );

  const status = () => s().status;
  const main = (
    <>
      <Note tone={status().tone}>
        <div class="text-base font-semibold">{status().head}</div>
        <Show when={status().line}>
          <div class="mt-1 line-clamp-4">{status().line}</div>
        </Show>
        <For each={status().list}>{(a) => <div>· {a}</div>}</For>
        <Show when={s().inTask}>
          <div class="mt-1.5 text-xs text-muted">{s().taskText}</div>
        </Show>
      </Note>
      <Show when={s().weeds.length > 0}>
        <div class="mt-2.5">
          <For each={s().weeds}>{(f) => <div class="text-sm text-berry">草 · {f.text}</div>}</For>
        </div>
      </Show>
      <Show when={(props.issue.criteria ?? []).length > 0 ? props.issue.criteria : undefined}>
        {(criteria) => (
          <div class="mt-3 border-t border-line">
            {/* Folded to its count; it opens itself when the work comes back for review, to be ticked one by one. */}
            <Fold label="验收标准" summary={`${criteria().length} 条 · ${criteria()[0]}`} open={s().judging}>
              <Criteria criteria={criteria()} checking={s().judging} />
            </Fold>
          </div>
        )}
      </Show>
      <Show when={s().hasBox}>
        <div class="mt-4">
          <TextArea
            rows={s().judging ? 3 : 2}
            value={text()}
            disabled={busy()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing && s().enterSends && s().talking) {
                e.preventDefault();
                tell();
              }
            }}
            placeholder={s().placeholder}
            aria-label={s().boxLabel}
          />
          <div class="mt-2.5 flex flex-wrap gap-2">
            <Show when={s().talking}>
              <Button icon="button-send" disabled={busy() || !text().trim()} onClick={tell}>
                带话
              </Button>
            </Show>
            <Show when={s().judging}>
              <Button tone="primary" disabled={busy()} onClick={() => void accept(true)}>
                验收通过
              </Button>
              <Button tone="danger" disabled={busy() || !text().trim()} onClick={() => void accept(false)}>
                没过，照上面修
              </Button>
            </Show>
            <Show when={s().reopening}>
              <Button tone="primary" disabled={busy()} onClick={() => void reopen()}>
                重开
              </Button>
            </Show>
          </div>
        </div>
      </Show>
      <div class="mt-5 border-t border-line">
        <Show when={s().showsChanges}>
          <Fold label="改动" summary={changes() ? changesLine(changes()!) : undefined}>
            <Show when={changes()} fallback={<p class="text-sm text-muted">{changesQuery.isPending ? "在读……" : "读不到改动。"}</p>}>
              {(c) => (
                <div class="flex flex-col gap-2">
                  <ChangesHead changes={c()} />
                  <Show when={c().conflicts.length > 0}>
                    <div class="text-sm text-berry">
                      合进 {c().base} 会冲突：{c().conflicts.join("、")}
                    </div>
                  </Show>
                  <ChangesBody changes={c()} />
                </div>
              )}
            </Show>
          </Fold>
        </Show>
        <Fold label="干活过程" summary={steps()?.length ? stepsLine(steps()!) : undefined}>
          <Show when={steps()?.length ? steps() : undefined} fallback={<p class="text-xs text-faint">{noStepsText(head())}</p>}>
            {(st) => <WorkLog steps={st()} />}
          </Show>
        </Fold>
        <Fold label="每次干活" summary={s().historyLine}>
          <Runs issue={props.issue.id} version={`${props.tag}:${props.session?.runs}:${props.session?.phase._tag}`} />
        </Fold>
      </div>
    </>
  );

  const offers = (): JSX.Element[] => {
    const h = props.session;
    return h ? s().offers.map((o) => offer(o, h)) : [];
  };
  const side = (
    <>
      <Show when={offers().length > 0}>
        <div class="mb-3 flex flex-col gap-2">{offers()}</div>
      </Show>
      <Property label="状态">
        <span class="flex items-center gap-2">
          <Dot tone={tagTone[props.tag]} />
          {tagLabel[props.tag]}
        </span>
      </Property>
      <Property label="谁在做">{s().whoLine}</Property>
      <Show when={s().project}>
        <Property label="项目">{s().project}</Property>
      </Show>
      <Show when={s().acceptanceEditable}>
        <Property label="验收">
          <Pick
            label="验收"
            value={props.issue.acceptance}
            disabled={busy() || !s().open}
            onChange={(v) => {
              const id = props.issue.id;
              void act(() => api.issue.update({ id, body: { acceptance: v as Acceptance } }));
            }}
            options={[
              { value: "glance", label: "看一眼就收" },
              { value: "required", label: "必须过验收" },
            ]}
          />
        </Property>
      </Show>
      <Show when={props.issue.acceptedAt}>
        {(at) => (
          <Property label="验收过">
            <span class="text-accent">{wallClockText(at())}</span>
          </Property>
        )}
      </Show>
      <More>
        <Show when={s().crewLine}>
          <Property label="地上的人">{s().crewLine}</Property>
        </Show>
        <Show when={agent()?.model}>
          <Property label="模型">{agent()!.model}</Property>
        </Show>
        <Property label="档案">{agent()?.name ?? head().name}</Property>
        <Show when={head().branch}>
          <Property label="分支">
            <span class="font-mono text-xs">{head().branch}</span>
          </Property>
        </Show>
        <Show when={head().worktree}>
          {(worktree) => (
            <Property label="worktree">
              <span class="flex items-start gap-1">
                <span class="min-w-0 flex-1 font-mono text-xs break-all select-text">{worktree()}</span>
                <button
                  type="button"
                  aria-label="复制路径"
                  title="复制路径"
                  onClick={() => void navigator.clipboard?.writeText(worktree())}
                  class="cursor-pointer rounded p-0.5 hover:bg-hover"
                >
                  <Icon name="button-copy" size={14} />
                </button>
              </span>
            </Property>
          )}
        </Show>
        <Property label="开单">{wallClockText(props.issue.createdAt)}</Property>
        <Show when={props.issue.closedAt}>{(at) => <Property label="关单">{wallClockText(at())}</Property>}</Show>
        <Property label="做过">{s().historyLine}</Property>
        <Property label="用时">{s().usedLine(steps() ?? [], Date.now())}</Property>
        <Show when={s().pulled.length > 0}>
          <Property label="拔了的草">
            <For each={s().pulled}>{(f) => <div class="text-faint line-through">{f.text}</div>}</For>
          </Property>
        </Show>
      </More>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

/** The criteria; while it is judged, each can be ticked off as the owner checks it (on this page only). */
function Criteria(props: { criteria: string[]; checking: boolean }) {
  const [ticked, setTicked] = createSignal<ReadonlySet<number>>(new Set());
  const tick = (i: number) =>
    setTicked((t) => {
      const n = new Set(t);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <Show
      when={props.checking}
      fallback={
        <ul class="text-sm">
          <For each={props.criteria}>{(c) => <li>· {c}</li>}</For>
        </ul>
      }
    >
      <div>
        <div class="mb-1.5 text-xs font-semibold text-muted">照验收标准看，看过一条勾一条</div>
        <For each={props.criteria}>
          {(c, i) => (
            <label class="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 text-sm hover:bg-hover">
              <input type="checkbox" checked={ticked().has(i())} onChange={() => tick(i())} class="mt-0.5 size-4 accent-leaf" />
              <span class={{ "text-muted": ticked().has(i()) }}>{c}</span>
            </label>
          )}
        </For>
      </div>
    </Show>
  );
}

/** The runs of an issue, read again whenever `version` changes. */
function Runs(props: { issue: string; version: string }) {
  const query = useQuery(() => ({
    queryKey: ["issues", "runs", props.issue, props.version],
    queryFn: () => api.issue.runs({ id: props.issue }),
    placeholderData: <T,>(prev: T) => prev,
  }));
  const runs = () => ready(query, []);
  const now = () => Date.now();
  return (
    <Show when={runs().length > 0} fallback={<p class="text-xs text-faint">还没有干过活。</p>}>
      <div>
        <div class="mb-2 text-xs text-muted">{runs().length} 次</div>
        <For each={[...runs()].reverse()}>
          {(r) => (
            <div class="flex gap-3 pb-2 text-sm">
              <span class="w-20 shrink-0 text-muted">{wallClockText(r.startedAt)}</span>
              <span class="min-w-0 flex-1">
                {runText(r, now(), tookText)}
                <Show when={r.summary}>
                  <span class="mt-0.5 line-clamp-2 block text-xs text-muted">{r.summary}</span>
                </Show>
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

const stepsLine = (steps: SessionEvent[]) => {
  const tools = steps.filter((e) => e.type === "tool/call").length;
  return tools === 0 ? `${steps.length} 步` : `${steps.length} 步 · 用了 ${tools} 个工具`;
};

const stepWord: Partial<Record<SessionEvent["type"], string>> = {
  "run/start": "开工",
  "user/message": "听到",
  "memory/recalled": "想起",
  "assistant/thinking": "想",
  "assistant/message": "说",
  "tool/call": "用工具",
  "llm/retry": "重试",
  "run/error": "出错",
  "run/end": "收工",
};

/** The session's steps, newest last; tool results and usage are left to the farm's fuller log. */
function WorkLog(props: { steps: SessionEvent[] }) {
  const shown = () => props.steps.filter((e) => stepWord[e.type] !== undefined).slice(-240);
  return (
    <ol class="max-h-[420px] overflow-y-auto font-mono text-xs">
      <For each={shown()}>
        {(e) => (
          <li class="flex gap-2.5 border-b border-line/60 py-1 last:border-b-0">
            <span class="w-14 shrink-0 text-faint">{wallClockText(e.time)}</span>
            <span class={["w-12 shrink-0", e.type === "run/error" ? "text-berry" : e.type === "tool/call" ? "text-water" : "text-muted"]}>
              {stepWord[e.type]}
            </span>
            <span class="line-clamp-3 min-w-0 flex-1 font-sans text-sm break-words whitespace-pre-wrap">
              {e.type === "tool/call" ? (e.actionText ?? e.text) : e.text}
            </span>
          </li>
        )}
      </For>
    </ol>
  );
}

/** An issue for the manager: what it was asked, and its runs; the answers are in its channel. */
export function ManagerIssueDetail(props: { issue: Issue }) {
  const tag = () => issueTag(props.issue);
  return (
    <div>
      <div class="flex items-start gap-3 pr-10">
        <h1 class="flex-1 text-xl font-semibold">{props.issue.title}</h1>
        <span class="mt-1.5 text-xs text-muted">{tagLabel[tag()]}</span>
      </div>
      <div class="mt-4">
        <Property label="谁在做">管家</Property>
        <Show when={props.issue.description}>
          <Property label="要做的">
            <span class="text-base">{props.issue.description}</span>
          </Property>
        </Show>
        <Show when={props.issue.schedule}>
          <Property label="来自">定时：每次到点重开这张工单，管家答完就关上</Property>
        </Show>
        <Property label="开单">{wallClockText(props.issue.createdAt)}</Property>
        <Show when={props.issue.closedAt}>{(at) => <Property label="关单">{wallClockText(at())}</Property>}</Show>
        <Property label="回答">在它的频道里</Property>
      </div>
      <h2 class="mt-5 mb-2 text-sm font-semibold">每次干活</h2>
      <Runs issue={props.issue.id} version={`${props.issue.status}:${props.issue.closedAt}:${tagOpen(tag())}`} />
    </div>
  );
}
