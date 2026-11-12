import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Errored, For, Loading, Show, untrack } from "solid-js";

import { list, t } from "@vibevalley/i18n";
import {
  OutfitValues,
  SpeciesValues,
  type SessionView,
  type Agent,
  type Deliverable,
  DeliverableValues,
  type Issue,
  type IssueAct,
  type Session,
} from "@vibevalley/protocol";
import { isOneOf, sessionIdsOf } from "@vibevalley/protocol/rules";

import { aria, useNow } from "#/base/dom.tsx";
import { tookText, wallClockText } from "#/base/format.ts";
import { playBedFx } from "#/farm/commands.ts";
import { farm, farmActWords, overlayOf, useFarm } from "#/farm/store.ts";
import { useVillage } from "#/farm/world/load.ts";
import { cropLabel, issueOf, plotOf, stationOfSession } from "#/farm/world/plots.ts";
import { issueThreadOf } from "#/features/channel/index.ts";
import {
  createIssueActs,
  changesLine,
  issueSet,
  labeledIssue,
  sendLabel,
  issueMove,
  issueMoveOf,
  sendMove,
  type CriterionRow,
  issueState,
  nothingChanged,
  noStepsText,
  runText,
  useIssueChanges,
  useIssueHistory,
  useIssueRuns,
  useIssueTimeline,
} from "#/features/issue/index.ts";
import { createSessionEvents, WorkLog } from "#/features/session/index.ts";
import { useAgent } from "#/infra/agents.ts";
import { useCore, useFrames } from "#/infra/frame.ts";
import { ready } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { useIntents } from "#/state/intent.ts";
import { castPrefix, outfitLabel, speciesLabel } from "#/ui/domain/cast.ts";
import { createPixelAct, FarmDialog, FarmSection, PxButton, PxTextArea, SpriteIcon, toasts, ToastType } from "#/ui/pixel/index.ts";

const askTones: Record<string, JSX.ClassValue> = {
  berry: "bg-[color-mix(in_srgb,_var(--color-berry-500)_30%,_var(--color-cream-50))]",
  wheat: "bg-[color-mix(in_srgb,_var(--color-wheat)_30%,_var(--color-cream-50))]",
  water: "bg-[color-mix(in_srgb,_var(--color-water-500)_30%,_var(--color-cream-50))]",
  leaf: "bg-[color-mix(in_srgb,_var(--color-leaf-500)_30%,_var(--color-cream-50))]",
  faint: "bg-[color-mix(in_srgb,_var(--color-cream-300)_30%,_var(--color-cream-50))]",
  muted: "bg-[color-mix(in_srgb,_var(--color-bark-400)_30%,_var(--color-cream-50))]",
};

/** The plot's issue while the store says so (the inspect layer). */
const labelOf = <K extends string>(labels: Record<K, string>, values: readonly K[], word: string) => (isOneOf(values, word) ? labels[word] : word);

export function IssueView() {
  const inspect = useFarm((s) => overlayOf(s, "inspect")?.sessionId);
  const core = useCore();
  const session = () => {
    const id = inspect();
    return id ? core()?.sessions.find((s) => s.id === id) : undefined;
  };
  return (
    <Show when={session()}>
      {(s) => (
        <FarmDialog title={t("web.farm.plotOf", { name: s().name })} size="lg" testid="plot" onClose={() => farm.select(undefined)}>
          <PlotDetail session={s()} onDone={() => farm.select(undefined)} />
        </FarmDialog>
      )}
    </Show>
  );
}

function PlotDetail(props: { session: SessionView; onDone: () => void }) {
  const core = useCore();
  const router = useRouter();
  const moves = useIntents(issueMove);
  const history = useIssueHistory(() => true);
  const id = () => issueOf(props.session);
  const issue = () => core()?.issues.find((i) => i.id === id());
  const sessions = () => {
    const found = history.rows()?.find((h) => h.issue.id === id())?.sessions ?? [props.session];
    return found.length > 0 ? found : [props.session];
  };
  const hasThread = () => issueThreadOf(core()?.chat, id()) !== undefined;
  return (
    <Show when={issue()} fallback={<p class="text-sm leading-[1.5] text-bark-800">{t("web.farm.plot.unread")}</p>}>
      {(i) => (
        <IssueBody
          issue={i()}
          sessions={sessions()}
          session={props.session}
          onHarvest={(s) => {
            farm.review(s.id);
            props.onDone();
          }}
          onClose={(s) => {
            // The plot stays open until the server took it, showing it on its way; a refusal shows there with a retry.
            const done = props.onDone;
            void sendMove(moves, { id: issueOf(s), status: "canceled" }).done.then((d) => d?.replied !== undefined && done());
          }}
          onThread={
            hasThread()
              ? () => {
                  const thread = issueThreadOf(core()?.chat, id());
                  if (thread) farm.showChat(thread.id);
                  props.onDone();
                }
              : undefined
          }
          onNavigate={() => router.navigate(`/issues/${encodeURIComponent(id())}`)}
          onParent={
            i().parent
              ? () => {
                  const parent = i().parent;
                  if (parent) router.navigate(`/issues/${encodeURIComponent(parent)}`);
                  props.onDone();
                }
              : undefined
          }
        />
      )}
    </Show>
  );
}

function IssueBody(props: {
  issue: Issue;
  sessions: Session[];
  session: SessionView;
  onHarvest: (s: Session) => void;
  onClose: (s: Session) => void;
  onThread?: (() => void) | undefined;
  onNavigate: () => void;
  onParent?: (() => void) | undefined;
}) {
  const frames = useFrames();
  const now = useNow();
  // The farm plays the bed's effect once the server took a word to the helper or a fix.
  const acts = createIssueActs(() => props.issue, {
    act: createPixelAct(t("web.farm.plot.failed")),
    done: (a) => {
      if (a === "tell" || a === "answer" || a === "resolve") playBedFx(props.session, frames.frame?.view.plays, "water");
      else if (a === "cure") playBedFx(props.session, frames.frame?.view.plays, "spray");
    },
    complete: () => props.onHarvest(props.session),
    close: () => props.onClose(props.session),
    words: farmActWords,
    told: (title, description) => toasts.add({ type: ToastType.info, title, description }),
  });
  const { busy, text, setText, box, go } = acts;
  const s = createMemo(() => issueState(props.issue, props.sessions, props.session, frames.frame?.state.issues ?? []));
  const changes = useIssueChanges(
    () => props.issue.id,
    () => s().showsChanges,
  );
  const changed = () => ready(changes, undefined);
  const madeLabel = () => {
    const c = changed();
    if (!c) return t("web.farm.plot.made");
    return nothingChanged(c) ? t("web.farm.plot.madeNothing") : t("web.farm.plot.madeFiles", { n: c.files.length });
  };
  const timelineQuery = useIssueTimeline(
    () => props.issue,
    () => s().head.runs,
  );
  const timeline = () => ready(timelineQuery, undefined);
  const steps = createSessionEvents(
    () => s().head.id,
    () => true,
  );
  const agent = useAgent(() => s().head.agent);
  const state = () => s().stage.state;

  const sets = useIntents(issueSet);
  const deliver = () => {
    const shown = labeledIssue(props.issue, sets.list());
    return { value: shown.issue.deliver, state: shown.state("deliver") };
  };
  const setDeliver = (d: Deliverable) => sendLabel(sets, { id: props.issue.id, deliver: d });
  const moves = useIntents(issueMove);
  const move = () => issueMoveOf(props.issue.id, moves.list()); /** lead is read as it renders: the lead changes as the issue moves on. */
  const button = (a: IssueAct, lead: () => boolean) => (
    <PxButton
      data-act={a}
      tone={lead() ? "primary" : a === "close" || acts.rejecting(a) ? "danger" : "plain"}
      disabled={acts.disabled(a)}
      onClick={() => go(a)}
    >
      {acts.label(a)}
    </PxButton>
  );
  /** The block asks for the lead and its own others; the rest go in the row at the bottom. */
  const blockActs = () => (s().ask ? s().others.filter((a) => a !== "close" && a !== "stop") : []);
  const rowActs = () => {
    const all = s().stage.acts.map((a) => a.act);
    return s().ask ? all.filter((a) => a === "close" || a === "stop") : all;
  };
  const boxShown = () => state() === "asking" || state() === "canceled" || box() !== undefined;

  return (
    <div class="flex flex-col sm:flex-row gap-4 sm:items-start">
      <Aside session={s().head} agent={agent()} />
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-baseline gap-2">
          <span class="text-(length:--text-xs) text-bark-600">#{props.issue.number}</span>
          <h3 class="min-w-0 flex-1 truncate text-(length:--text-lg)" title={s().title}>
            {s().title}
          </h3>
          <Show when={s().repo}>
            <span class="text-(length:--text-xs) text-bark-600">{s().repo}</span>
          </Show>
        </div>
        <p
          class={["mt-1 text-(length:--text-sm)", s().stage.state === "stuck" ? "text-berry-500" : "text-bark-700"]}
          aria-label={t("web.farm.plot.now")}
          data-testid="issue-now"
          data-state={s().stage.state}
        >
          {s().statusLine(now(), timeline()?.spent?.cny)}
        </p>

        <Show when={s().ask}>
          {(ask) => (
            <div
              class={["mt-3 p-3", askTones[ask().tone] ?? "bg-[color-mix(in_srgb,_var(--color-cream-300)_30%,_var(--color-cream-50))]"]}
              aria-label={t("web.farm.plot.yours")}
              role="region"
            >
              <p class="text-(length:--text-base)">{ask().head}</p>
              <Show when={ask().line}>
                <p class="mt-1 line-clamp-4 text-sm leading-[1.5] whitespace-pre-wrap text-bark-800">{ask().line}</p>
              </Show>
              <Show when={state() === "asking"}>
                <For each={props.issue.questions}>
                  {(q) => (
                    <div class="mt-2">
                      <p class="text-sm leading-[1.5] text-bark-800">{q.question}</p>
                      <Show when={q.options.length}>
                        <div class="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label={t("web.farm.plot.answerTo", { question: q.question })}>
                          <For each={q.options}>
                            {(o) => (
                              <PxButton size="sm" disabled={busy()} onClick={() => void acts.send("answer", o).then((ok) => ok && acts.setText(""))}>
                                {o}
                              </PxButton>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          )}
        </Show>
        <Show when={boxShown()}>
          <div class="mt-2">
            <PxTextArea
              value={text()}
              onChange={setText}
              rows={box() === "reject" ? 3 : 2}
              placeholder={
                box() === "reject"
                  ? t("web.farm.plot.rejectWhere")
                  : state() === "asking"
                    ? t("web.farm.plot.sayIt")
                    : state() === "canceled"
                      ? t("web.farm.plot.reopenWhat")
                      : props.session.phase._tag === "working"
                        ? t("web.farm.plot.tellWorking")
                        : t("web.farm.plot.tellIdle")
              }
              label={
                box() === "reject"
                  ? t("web.farm.plot.rejectLabel")
                  : state() === "asking"
                    ? t("web.farm.plot.answer")
                    : state() === "canceled"
                      ? t("web.farm.plot.reopen")
                      : t("web.farm.plot.tell", { who: props.session.name })
              }
              disabled={busy()}
            />
          </div>
        </Show>
        <Show when={move()}>
          {(m) => (
            <div data-testid="issue-move" data-state={m().state} class="mt-2 flex items-center gap-1.5 text-(length:--text-xs)">
              <span class={["min-w-0 flex-1 truncate", m().state === "failed" ? "text-berry" : "text-bark-600"]} title={m().reason}>
                {m().state === "moving" ? t("web.farm.plot.moving") : (m().reason ?? t("web.farm.plot.notMoved"))}
              </span>
              <Show when={m().state === "failed"}>
                <PxButton size="sm" data-testid="move-retry" onClick={() => void moves.retry(untrack(m).key)}>
                  {t("web.farm.plot.moveAgain")}
                </PxButton>
                <PxButton size="sm" data-testid="move-put-back" onClick={() => moves.drop(untrack(m).key)}>
                  {t("web.farm.plot.letGo")}
                </PxButton>
              </Show>
            </div>
          )}
        </Show>
        <For each={acts.words()} keyed={(w) => w.key}>
          {(w) => (
            <div data-testid="issue-said" data-key={w().key} data-state={w().state} class="mt-2 flex items-center gap-1.5 text-(length:--text-xs)">
              <span class="min-w-0 flex-1 truncate text-sm leading-[1.5] text-bark-800">{w().text}</span>
              <span class={["", w().state === "failed" ? "text-berry" : "text-bark-600"]} title={w().reason}>
                {w().state === "sending" ? t("web.farm.plot.sending") : (w().reason ?? t("web.farm.plot.notSaid"))}
              </span>
              <Show when={w().state === "failed"}>
                <PxButton size="sm" data-testid="said-retry" onClick={() => acts.sayAgain(untrack(w).key)}>
                  {t("web.farm.plot.sayAgain")}
                </PxButton>
                <PxButton size="sm" data-testid="said-take-back" onClick={() => acts.takeBack(untrack(w).key)}>
                  {t("web.farm.plot.takeBack")}
                </PxButton>
              </Show>
            </div>
          )}
        </For>
        <div class="mt-3 flex flex-wrap gap-2">
          <Show when={s().ask && s().lead} keyed>
            {(lead) => button(lead, () => true)}
          </Show>
          <For each={blockActs()}>{(a) => button(a, () => false)}</For>
          <For each={rowActs()}>{(a) => button(a, () => !s().ask && a === s().lead)}</For>
          <PxButton icon="button-open" onClick={() => props.onNavigate()}>
            {t("web.farm.plot.onBoard")}
          </PxButton>
        </div>

        <FarmSection title={s().criteria.length > 0 ? t("web.farm.plot.progressMet", { met: s().met, of: s().criteria.length }) : t("web.farm.plot.progress")}>
          <Show when={s().doing}>
            <p class="text-sm leading-[1.5] text-water-500">{s().doing}</p>
          </Show>
          <Show when={s().inFamily}>
            <p class="text-(length:--text-xs) text-bark-600">{s().parentText}</p>
          </Show>
          <Show
            when={s().criteria.length > 0}
            fallback={<p class="text-(length:--text-xs) text-bark-600">{t("web.farm.plot.noCriteria", { answer: props.issue.deliver === "answer" })}</p>}
          >
            <Criteria rows={s().criteria} checking={state() === "reviewing" && props.issue.reviewedAt === undefined} />
          </Show>
          <Show when={s().openFindings.length > 0}>
            <div class="mt-1.5">
              <For each={s().openFindings}>{(f) => <p class="text-sm leading-[1.5] text-berry">{t("web.farm.plot.rejected", { text: f.text })}</p>}</For>
            </div>
          </Show>
        </FarmSection>

        <div class="mt-4">
          <Show when={props.issue.deliver === "answer" ? props.issue.answer : undefined}>
            {(a) => (
              <FarmSection title={t("web.farm.plot.conclusion")}>
                <p class="text-sm leading-[1.5] text-bark-800">{a().conclusion}</p>
                <For each={a().evidence}>{(l) => <p class="text-(length:--text-xs) text-bark-600">{t("web.farm.plot.evidence", { line: l })}</p>}</For>
                <For each={a().next}>{(l) => <p class="text-(length:--text-xs) text-bark-600">{t("web.farm.plot.next", { line: l })}</p>}</For>
              </FarmSection>
            )}
          </Show>
          <Show when={s().showsChanges && props.issue.deliver !== "answer"}>
            <Fold label={madeLabel()}>
              <Show
                when={changed()}
                fallback={
                  <p class="text-sm leading-[1.5] text-bark-800">{changes.status() === "pending" ? t("web.farm.reading") : t("web.farm.plot.changesUnread")}</p>
                }
              >
                {(c) => (
                  <div class="flex flex-col">
                    <p class="text-sm leading-[1.5] text-bark-800">{changesLine(c())}</p>
                    <Show when={c().conflicts.length > 0}>
                      <p class="text-sm leading-[1.5] text-berry">{t("web.farm.plot.conflict", { base: c().base, files: list(c().conflicts) })}</p>
                    </Show>
                    <div class="mt-1.5">
                      <For each={c().files.slice(0, 12)}>
                        {(f) => (
                          <p class="truncate font-mono text-(length:--text-2xs) text-bark-800">
                            {f.path} +{Math.round(f.added)} -{Math.round(f.removed)}
                          </p>
                        )}
                      </For>
                      <Show when={c().files.length > 12}>
                        <p class="text-(length:--text-xs) text-bark-600">{t("web.farm.plot.moreFiles", { n: c().files.length - 12 })}</p>
                      </Show>
                    </div>
                  </div>
                )}
              </Show>
            </Fold>
          </Show>
          <Fold label={t("web.farm.plot.story")}>
            <Show
              when={timeline()}
              fallback={
                <p class="text-(length:--text-xs) text-bark-600">{timelineQuery.status() === "pending" ? t("web.farm.reading") : t("web.farm.unread")}</p>
              }
            >
              {(line) => (
                <For each={line().milestones}>
                  {(m) => (
                    <Row label={wallClockText(m.at)}>
                      <p class={["text-sm leading-[1.5]", m.kind === "failed" || m.kind === "rejected" ? "text-berry" : "text-bark-800"]}>
                        {m.who ? `${m.who} · ` : ""}
                        {m.text}
                      </p>
                    </Row>
                  )}
                </For>
              )}
            </Show>
          </Fold>
          <Fold label={t("web.farm.plot.steps")}>
            <Show when={steps().length > 0} fallback={<p class="text-(length:--text-xs) text-bark-600">{noStepsText(s().head)}</p>}>
              <WorkLog steps={steps()} now={now()} working={state() === "working"} />
            </Show>
          </Fold>
          <Fold label={t("web.farm.plot.runs")}>
            <Runs issue={props.issue.id} version={`${sessionIdsOf(props.issue).length}:${s().head.runs}:${s().head.phase._tag}`} />
          </Fold>
          <Fold label={t("web.farm.plot.details")}>
            <div class="flex flex-col">
              <Show when={s().description}>
                <Row label={t("web.farm.plot.job")}>
                  <p class="text-(length:--text-sm) whitespace-pre-wrap text-bark-800">{s().description}</p>
                </Row>
              </Show>
              <Row label={t("web.farm.plot.who")}>
                <p class="text-sm leading-[1.5] text-bark-800">{s().whoLine}</p>
              </Row>
              <Show when={s().crewLine}>
                <Row label={t("web.farm.plot.crew")}>
                  <p class="text-sm leading-[1.5] text-bark-800">{s().crewLine}</p>
                </Row>
              </Show>
              <Show when={!s().inFamily}>
                <Row label={t("web.farm.plot.deliver")}>
                  <div class="flex flex-wrap items-center gap-1.5" data-testid="plot-deliver" data-value={deliver().value} data-state={deliver().state}>
                    <For each={DeliverableValues}>
                      {(d) => (
                        <PxButton
                          size="sm"
                          tone={deliver().value === d ? "primary" : "plain"}
                          disabled={busy() || deliver().value === d || !s().open}
                          onClick={() => void setDeliver(d)}
                        >
                          {t(`shared.deliverable.${d}`)}
                        </PxButton>
                      )}
                    </For>
                    <Show when={props.issue.reviewedAt}>
                      {(at) => <span class="text-(length:--text-xs) text-leaf-700">{t("web.farm.plot.reviewed", { clock: wallClockText(at()) })}</span>}
                    </Show>
                  </div>
                </Row>
              </Show>
              <Show when={s().resolvedFindings.length > 0}>
                <Row label={t("web.farm.plot.weeded")}>
                  <For each={s().resolvedFindings}>
                    {(f) => <p class="text-sm leading-[1.5] text-bark-800 line-through">{t("web.farm.plot.weed", { text: f.text })}</p>}
                  </For>
                </Row>
              </Show>
              <Show when={agent()?.model}>
                {(model) => (
                  <Row label={t("web.farm.plot.model")}>
                    <p class="text-sm leading-[1.5] text-bark-800">{model()}</p>
                  </Row>
                )}
              </Show>
              <Show when={s().head.branch}>
                <Row label={t("web.farm.plot.branch")}>
                  <p class="font-mono text-[length:12.5px] text-bark-800">{s().head.branch}</p>
                </Row>
              </Show>
              <Show when={s().head.worktree}>
                {(tree) => (
                  <Row label="worktree">
                    <div class="flex items-center gap-2">
                      <span class="min-w-0 flex-1 font-mono text-[length:12.5px] break-all select-text">{tree()}</span>
                      <PxButton size="sm" onClick={() => void navigator.clipboard.writeText(tree())}>
                        {t("web.farm.plot.copyPath")}
                      </PxButton>
                    </div>
                  </Row>
                )}
              </Show>
              <Row label={t("web.farm.plot.opened")}>
                <p class="text-sm leading-[1.5] text-bark-800">{wallClockText(props.issue.createdAt)}</p>
              </Row>
              <Show when={props.issue.closedAt}>
                {(at) => (
                  <Row label={t("web.farm.plot.closed")}>
                    <p class="text-sm leading-[1.5] text-bark-800">{wallClockText(at())}</p>
                  </Row>
                )}
              </Show>
              <Row label={t("web.farm.plot.history")}>
                <p class="text-sm leading-[1.5] text-bark-800">{s().historyLine}</p>
              </Row>
              <Row label={t("web.farm.plot.took")}>
                <p class="text-sm leading-[1.5] text-bark-800">{s().usedLine(steps(), now())}</p>
              </Row>
              <div class="flex flex-wrap gap-2">
                <Show when={props.onThread}>
                  <PxButton size="sm" onClick={() => props.onThread?.()}>
                    {t("web.farm.plot.thread")}
                  </PxButton>
                </Show>
                <Show when={s().inFamily && props.onParent}>
                  <PxButton size="sm" onClick={() => props.onParent?.()}>
                    {t("web.issue.family.parent")}
                  </PxButton>
                </Show>
              </div>
            </div>
          </Fold>
        </div>
      </div>
    </div>
  );
}

/** The helper on its crop, what it is and which plot and round. */
function Aside(props: { session: Session; agent?: Agent | undefined }) {
  const loaded = useVillage();
  const frames = useFrames();
  const plot = () => (frames.frame ? plotOf(frames.frame.view, props.session) : { crop: "empty" as const });
  const atlas = () => loaded().village?.atlas;
  const prefix = () => {
    const a = atlas();
    return a ? castPrefix(props.agent?.look, props.session.agent, (n) => a.has(n)) : undefined;
  };
  const kind = () => (prefix() ?? "bear-farmer").split("-");
  const crop = () => {
    const a = atlas();
    return a?.has(`plot-${plot().crop}`) === true ? a.get(`plot-${plot().crop}`) : undefined;
  };
  const figure = () => {
    const a = atlas();
    const p = prefix();
    return p && a ? a.get(`${p}-down`) : undefined;
  };
  return (
    <div class="flex w-full sm:w-52 shrink-0 flex-col items-center bg-cream-100 p-3">
      <div class="relative flex h-44 w-44 items-end justify-center">
        <Show when={crop()}>{(c) => <img src={c().url} alt="" class="absolute bottom-0 w-44 opacity-90 [image-rendering:pixelated]" />}</Show>
        <Show when={figure()}>{(f) => <img src={f().url} alt="" class="relative h-36 [image-rendering:pixelated]" />}</Show>
      </div>
      <p class="mt-2 text-(length:--text-sm)">{cropLabel[plot().crop]}</p>
      <p class="text-center text-(length:--text-xs) text-bark-600">
        {labelOf(speciesLabel, SpeciesValues, kind()[0] ?? "")} · {labelOf(outfitLabel, OutfitValues, kind()[1] ?? "")}
      </p>
      <p class="text-(length:--text-xs) text-bark-600">
        {t("web.farm.plot.where", { plot: stationOfSession(props.session, frames.frame?.view.plays) + 1, round: Math.round(props.session.runs) })}
      </p>
    </div>
  );
}

const resultMark: Record<NonNullable<CriterionRow["result"]>, { icon: string; label: string }> = {
  met: { icon: "mark-check", label: t("web.farm.plot.result.met") },
  unmet: { icon: "mark-cross", label: t("web.farm.plot.result.unmet") },
  unsure: { icon: "mark-warn", label: t("web.farm.plot.result.unsure") },
};

/** The criteria with the helper's word on each; while it is judged, each can be ticked off as the user checks it (on
 * this page only). */
function Criteria(props: { rows: CriterionRow[]; checking: boolean }) {
  const [ticked, setTicked] = createSignal<ReadonlySet<number>>(new Set());
  const mark = (r: CriterionRow) => (r.result ? <SpriteIcon name={resultMark[r.result].icon} size={14} label={resultMark[r.result].label} /> : undefined);
  return (
    <div class="flex flex-col">
      <For each={props.rows} keyed={(r) => r.text}>
        {(r, i) => (
          <Show
            when={props.checking}
            fallback={
              <div class="flex items-start gap-2 py-0.5">
                <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{mark(r()) ?? <span class="h-2.5 w-2.5 border-2" />}</span>
                <span class="min-w-0 flex-1">
                  <span class="text-sm leading-[1.5] text-bark-800">{r().text}</span>
                  <Show when={r().proof}>
                    <span class="block text-(length:--text-xs) text-bark-600">{r().proof}</span>
                  </Show>
                </span>
              </div>
            }
          >
            <button
              type="button"
              data-testid="criterion-tick"
              data-key={i()}
              aria-pressed={aria(ticked().has(i()))}
              aria-label={r().text}
              onClick={() => setTicked((was) => (was.has(i()) ? new Set([...was].filter((x) => x !== i())) : new Set([...was, i()])))}
              class={["group/farm-group", "flex cursor-pointer items-start gap-2 py-0.5 text-left"]}
            >
              <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border-2 bg-cream-50 border-bark-400 group-hover/farm-group:border-bark-600">
                <Show when={ticked().has(i())}>
                  <SpriteIcon name="mark-check" size={12} label={t("web.farm.plot.ticked")} />
                </Show>
              </span>
              <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{mark(r())}</span>
              <span class="min-w-0 flex-1">
                <span class="text-sm leading-[1.5] text-bark-800">{r().text}</span>
                <Show when={r().proof}>
                  <span class="block text-(length:--text-xs) text-bark-600">{r().proof}</span>
                </Show>
              </span>
            </button>
          </Show>
        )}
      </For>
    </div>
  );
}

function Fold(props: { label: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="border-t border-cream-300">
      <button
        type="button"
        data-testid="fold"
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        class={["group/farm-group", "flex w-full cursor-pointer items-center gap-1.5 py-2 text-left"]}
      >
        <SpriteIcon name="button-next" size={12} class={open() && "[rotate:90deg]"} />
        <span class="text-(length:--text-sm) text-bark-800 group-hover/farm-group:text-bark-900">{props.label}</span>
      </button>
      {/* Mounted with the dialog and only hidden while folded. */}
      <div class="pb-3" hidden={!open()}>
        <Errored fallback={<p class="text-(length:--text-xs) text-bark-500">{t("web.farm.unread")}</p>}>
          <Loading fallback={<p class="text-(length:--text-xs) text-bark-500">{t("web.farm.reading")}</p>}>{props.children}</Loading>
        </Errored>
      </div>
    </div>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div class="mb-2 flex items-start gap-3">
      <span class="w-18 shrink-0 text-(length:--text-sm) text-bark-500">{props.label}</span>
      <div class="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

/** The issue's runs, read again whenever `version` changes. */
function Runs(props: { issue: string; version: string }) {
  const runsQuery = useIssueRuns(
    () => props.issue,
    () => props.version,
  );
  const runs = () => ready(runsQuery, []);
  const now = useNow();
  return (
    <Show when={runs().length > 0} fallback={<p class="text-(length:--text-xs) text-bark-600">{t("web.farm.plot.noRuns")}</p>}>
      <FarmSection title={t("web.farm.plot.runs")}>
        <p class="text-(length:--text-xs) text-bark-600">{t("web.farm.plot.runCount", { n: runs().length })}</p>
        <For each={[...runs()].toReversed()} keyed={(r) => r.id}>
          {(r) => (
            <Row label={wallClockText(r().startedAt)}>
              <p class="text-sm leading-[1.5] text-bark-800">{runText(r(), now(), tookText)}</p>
            </Row>
          )}
        </For>
      </FarmSection>
    </Show>
  );
}
