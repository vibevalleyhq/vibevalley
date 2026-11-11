import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
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
import { farmGroup } from "#/farm/interaction.stylex.ts";
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
import { styleProps } from "#/ui/positioner.ts";

const styles = stylex.create({
  emptyCriterion: { height: "0.625rem", width: "0.625rem", borderStyle: "solid", borderWidth: "2px" },
  criterion: {
    display: "flex",
    cursor: "pointer",
    alignItems: "flex-start",
    gap: "0.5rem",
    paddingBlock: "0.125rem",
    textAlign: "left",
  },
  criterionBox: {
    marginTop: "0.125rem",
    display: "flex",
    height: "1rem",
    width: "1rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderStyle: "solid",
    borderWidth: "2px",
    backgroundColor: "var(--color-cream-50)",
    borderColor: {
      default: "var(--color-bark-400)",
      "@media (hover:hover)": { default: null, [stylex.when.ancestor(":hover", farmGroup)]: "var(--color-bark-600)" },
    },
  },
  fold: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.375rem",
    paddingBlock: "0.5rem",
    textAlign: "left",
  },
  foldOpen: { rotate: "90deg" },
  foldLabel: {
    fontSize: "13px",
    color: {
      default: "var(--color-bark-800)",
      "@media (hover:hover)": { default: null, [stylex.when.ancestor(":hover", farmGroup)]: "var(--color-bark-900)" },
    },
  },
  issueBodySpan: {
    minWidth: "0",
    flex: "1",
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    wordBreak: "break-all",
    WebkitUserSelect: "text",
    userSelect: "text",
  },
  plotDetailP: {
    fontSize: "13px",
    lineHeight: "1.5",
    color: "var(--color-bark-800)",
  },
  issueBodySpan2: {
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  issueBodyP: {
    marginTop: "0.25rem",
    WebkitLineClamp: "4",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "13px",
    lineHeight: "1.5",
    whiteSpace: "pre-wrap",
    color: "var(--color-bark-800)",
  },
  issueBodySpan22: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "13px",
    lineHeight: "1.5",
    color: "var(--color-bark-800)",
  },
  issueBodyP2: {
    fontSize: "13px",
    lineHeight: "1.5",
    color: "var(--color-water-500)",
  },
  issueBodyP3: {
    fontSize: "13px",
    lineHeight: "1.5",
    color: "var(--color-berry)",
  },
  issueBodyP4: {
    fontSize: "13px",
    lineHeight: "1.5",
  },
  issueBodyPPrimary: {
    color: "var(--color-bark-800)",
  },
  issueBodyPSecondary: {
    color: "var(--color-berry)",
  },
  issueBodyP5: {
    fontSize: "13px",
    lineHeight: "1.5",
    color: "var(--color-bark-800)",
    textDecorationLine: "line-through",
  },
  asideP: {
    textAlign: "center",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  criteriaSpan: {
    display: "block",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  issueBodyDiv: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  issueBodySpan3: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  issueBodySpanTone: {
    color: "var(--color-berry)",
  },
  issueBodySpanAlt: {
    color: "var(--color-bark-600)",
  },
  issueBodySpan23: {},
  issueBodyDiv2: {
    display: "flex",
    flexDirection: {
      default: "column",
      "@media (width>=40rem)": "row",
    },
    gap: "1rem",
    alignItems: {
      default: null,
      "@media (width>=40rem)": "flex-start",
    },
  },
  issueBodyDiv22: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
  },
  issueBodyH3: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "16px",
  },
  issueNow: {
    marginTop: "0.25rem",
    fontSize: "13px",
  },
  issueStuck: {
    color: "var(--color-berry-500)",
  },
  issueActive: {
    color: "var(--color-bark-700)",
  },
  issueBodyDiv3: {
    marginTop: "0.75rem",
    padding: "0.75rem",
  },
  askBerry: {
    backgroundColor: "color-mix(in srgb, var(--color-berry-500) 30%, var(--color-cream-50))",
  },
  askWheat: {
    backgroundColor: "color-mix(in srgb, var(--color-wheat) 30%, var(--color-cream-50))",
  },
  askWater: {
    backgroundColor: "color-mix(in srgb, var(--color-water-500) 30%, var(--color-cream-50))",
  },
  askLeaf: {
    backgroundColor: "color-mix(in srgb, var(--color-leaf-500) 30%, var(--color-cream-50))",
  },
  askFaint: {
    backgroundColor: "color-mix(in srgb, var(--color-cream-300) 30%, var(--color-cream-50))",
  },
  askMuted: {
    backgroundColor: "color-mix(in srgb, var(--color-bark-400) 30%, var(--color-cream-50))",
  },
  issueBodyP6: {
    fontSize: "14px",
  },
  issueBodyDiv4: {
    marginTop: "0.5rem",
  },
  issueBodyDiv5: {
    marginTop: "0.375rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
  },
  issueMove: {
    marginTop: "0.5rem",
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: "12px",
  },
  issueBodyDiv6: {
    marginTop: "0.75rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  issueBodyDiv7: {
    marginTop: "0.375rem",
  },
  issueBodyDiv8: {
    marginTop: "1rem",
  },
  issueBodyDiv9: {
    display: "flex",
    flexDirection: "column",
  },
  issueBodyP22: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    color: "var(--color-bark-800)",
  },
  issueBodyP32: {
    fontSize: "13px",
    whiteSpace: "pre-wrap",
    color: "var(--color-bark-800)",
  },
  plotDeliver: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.375rem",
  },
  issueBodySpan4: {
    fontSize: "12px",
    color: "var(--color-leaf-700)",
  },
  issueBodyP42: {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    color: "var(--color-bark-800)",
  },
  issueBodyDiv10: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  issueBodyDiv11: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  asideDiv: {
    display: "flex",
    width: {
      default: "100%",
      "@media (width>=40rem)": "13rem",
    },
    flexShrink: "0",
    flexDirection: "column",
    alignItems: "center",
    backgroundColor: "var(--color-cream-100)",
    padding: "0.75rem",
  },
  asideDiv2: {
    position: "relative",
    display: "flex",
    height: "11rem",
    width: "11rem",
    alignItems: "flex-end",
    justifyContent: "center",
  },
  asideImg: {
    position: "absolute",
    bottom: "0",
    width: "11rem",
    opacity: ".9",
    imageRendering: "pixelated",
  },
  asideImg2: {
    position: "relative",
    height: "9rem",
    imageRendering: "pixelated",
  },
  asideP2: {
    marginTop: "0.5rem",
    fontSize: "13px",
  },
  criteriaDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.5rem",
    paddingBlock: "0.125rem",
  },
  criteriaSpan2: {
    marginTop: "0.125rem",
    display: "flex",
    height: "1rem",
    width: "1rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
  },
  criteriaSpan22: {
    minWidth: "0",
    flex: "1",
  },
  foldDiv: {
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-cream-300)",
  },
  foldDiv2: {
    paddingBottom: "0.75rem",
  },
  foldP: {
    fontSize: "12px",
    color: "var(--color-bark-500)",
  },
  rowDiv: {
    marginBottom: "0.5rem",
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
  },
  rowSpan: {
    width: "72px",
    flexShrink: "0",
    fontSize: "13px",
    color: "var(--color-bark-500)",
  },
});

const askTones: Record<string, stylex.StyleXStyles> = {
  berry: styles.askBerry,
  wheat: styles.askWheat,
  water: styles.askWater,
  leaf: styles.askLeaf,
  faint: styles.askFaint,
  muted: styles.askMuted,
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
    <Show when={issue()} fallback={<p {...stylex.attrs(styles.plotDetailP)}>{t("web.farm.plot.unread")}</p>}>
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
    <div {...stylex.attrs(styles.issueBodyDiv2)}>
      <Aside session={s().head} agent={agent()} />
      <div {...stylex.attrs(styles.issueBodyDiv)}>
        <div {...stylex.attrs(styles.issueBodyDiv22)}>
          <span {...stylex.attrs(styles.issueBodySpan2)}>#{props.issue.number}</span>
          <h3 {...stylex.attrs(styles.issueBodyH3)} title={s().title}>
            {s().title}
          </h3>
          <Show when={s().repo}>
            <span {...stylex.attrs(styles.issueBodySpan2)}>{s().repo}</span>
          </Show>
        </div>
        <p
          {...stylex.attrs(styles.issueNow, s().stage.state === "stuck" ? styles.issueStuck : styles.issueActive)}
          aria-label={t("web.farm.plot.now")}
          data-testid="issue-now"
          data-state={s().stage.state}
        >
          {s().statusLine(now(), timeline()?.spent?.cny)}
        </p>

        <Show when={s().ask}>
          {(ask) => (
            <div {...styleProps([styles.issueBodyDiv3, askTones[ask().tone] ?? styles.askFaint])} aria-label={t("web.farm.plot.yours")} role="region">
              <p {...stylex.attrs(styles.issueBodyP6)}>{ask().head}</p>
              <Show when={ask().line}>
                <p {...stylex.attrs(styles.issueBodyP)}>{ask().line}</p>
              </Show>
              <Show when={state() === "asking"}>
                <For each={props.issue.questions}>
                  {(q) => (
                    <div {...stylex.attrs(styles.issueBodyDiv4)}>
                      <p {...stylex.attrs(styles.plotDetailP)}>{q.question}</p>
                      <Show when={q.options.length}>
                        <div {...stylex.attrs(styles.issueBodyDiv5)} role="group" aria-label={t("web.farm.plot.answerTo", { question: q.question })}>
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
          <div {...stylex.attrs(styles.issueBodyDiv4)}>
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
            <div data-testid="issue-move" data-state={m().state} {...stylex.attrs(styles.issueMove)}>
              <span {...stylex.attrs(styles.issueBodySpan3, m().state === "failed" ? styles.issueBodySpanTone : styles.issueBodySpanAlt)} title={m().reason}>
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
            <div data-testid="issue-said" data-key={w().key} data-state={w().state} {...stylex.attrs(styles.issueMove)}>
              <span {...stylex.attrs(styles.issueBodySpan22)}>{w().text}</span>
              <span {...stylex.attrs(styles.issueBodySpan23, w().state === "failed" ? styles.issueBodySpanTone : styles.issueBodySpanAlt)} title={w().reason}>
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
        <div {...stylex.attrs(styles.issueBodyDiv6)}>
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
            <p {...stylex.attrs(styles.issueBodyP2)}>{s().doing}</p>
          </Show>
          <Show when={s().inFamily}>
            <p {...stylex.attrs(styles.issueBodySpan2)}>{s().parentText}</p>
          </Show>
          <Show
            when={s().criteria.length > 0}
            fallback={<p {...stylex.attrs(styles.issueBodySpan2)}>{t("web.farm.plot.noCriteria", { answer: props.issue.deliver === "answer" })}</p>}
          >
            <Criteria rows={s().criteria} checking={state() === "reviewing" && props.issue.reviewedAt === undefined} />
          </Show>
          <Show when={s().openFindings.length > 0}>
            <div {...stylex.attrs(styles.issueBodyDiv7)}>
              <For each={s().openFindings}>{(f) => <p {...stylex.attrs(styles.issueBodyP3)}>{t("web.farm.plot.rejected", { text: f.text })}</p>}</For>
            </div>
          </Show>
        </FarmSection>

        <div {...stylex.attrs(styles.issueBodyDiv8)}>
          <Show when={props.issue.deliver === "answer" ? props.issue.answer : undefined}>
            {(a) => (
              <FarmSection title={t("web.farm.plot.conclusion")}>
                <p {...stylex.attrs(styles.plotDetailP)}>{a().conclusion}</p>
                <For each={a().evidence}>{(l) => <p {...stylex.attrs(styles.issueBodySpan2)}>{t("web.farm.plot.evidence", { line: l })}</p>}</For>
                <For each={a().next}>{(l) => <p {...stylex.attrs(styles.issueBodySpan2)}>{t("web.farm.plot.next", { line: l })}</p>}</For>
              </FarmSection>
            )}
          </Show>
          <Show when={s().showsChanges && props.issue.deliver !== "answer"}>
            <Fold label={madeLabel()}>
              <Show
                when={changed()}
                fallback={
                  <p {...stylex.attrs(styles.plotDetailP)}>{changes.status() === "pending" ? t("web.farm.reading") : t("web.farm.plot.changesUnread")}</p>
                }
              >
                {(c) => (
                  <div {...stylex.attrs(styles.issueBodyDiv9)}>
                    <p {...stylex.attrs(styles.plotDetailP)}>{changesLine(c())}</p>
                    <Show when={c().conflicts.length > 0}>
                      <p {...stylex.attrs(styles.issueBodyP3)}>{t("web.farm.plot.conflict", { base: c().base, files: list(c().conflicts) })}</p>
                    </Show>
                    <div {...stylex.attrs(styles.issueBodyDiv7)}>
                      <For each={c().files.slice(0, 12)}>
                        {(f) => (
                          <p {...stylex.attrs(styles.issueBodyP22)}>
                            {f.path} +{Math.round(f.added)} -{Math.round(f.removed)}
                          </p>
                        )}
                      </For>
                      <Show when={c().files.length > 12}>
                        <p {...stylex.attrs(styles.issueBodySpan2)}>{t("web.farm.plot.moreFiles", { n: c().files.length - 12 })}</p>
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
              fallback={<p {...stylex.attrs(styles.issueBodySpan2)}>{timelineQuery.status() === "pending" ? t("web.farm.reading") : t("web.farm.unread")}</p>}
            >
              {(line) => (
                <For each={line().milestones}>
                  {(m) => (
                    <Row label={wallClockText(m.at)}>
                      <p
                        {...stylex.attrs(
                          styles.issueBodyP4,
                          m.kind === "failed" || m.kind === "rejected" ? styles.issueBodyPSecondary : styles.issueBodyPPrimary,
                        )}
                      >
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
            <Show when={steps().length > 0} fallback={<p {...stylex.attrs(styles.issueBodySpan2)}>{noStepsText(s().head)}</p>}>
              <WorkLog steps={steps()} now={now()} working={state() === "working"} />
            </Show>
          </Fold>
          <Fold label={t("web.farm.plot.runs")}>
            <Runs issue={props.issue.id} version={`${sessionIdsOf(props.issue).length}:${s().head.runs}:${s().head.phase._tag}`} />
          </Fold>
          <Fold label={t("web.farm.plot.details")}>
            <div {...stylex.attrs(styles.issueBodyDiv9)}>
              <Show when={s().description}>
                <Row label={t("web.farm.plot.job")}>
                  <p {...stylex.attrs(styles.issueBodyP32)}>{s().description}</p>
                </Row>
              </Show>
              <Row label={t("web.farm.plot.who")}>
                <p {...stylex.attrs(styles.plotDetailP)}>{s().whoLine}</p>
              </Row>
              <Show when={s().crewLine}>
                <Row label={t("web.farm.plot.crew")}>
                  <p {...stylex.attrs(styles.plotDetailP)}>{s().crewLine}</p>
                </Row>
              </Show>
              <Show when={!s().inFamily}>
                <Row label={t("web.farm.plot.deliver")}>
                  <div {...stylex.attrs(styles.plotDeliver)} data-testid="plot-deliver" data-value={deliver().value} data-state={deliver().state}>
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
                      {(at) => <span {...stylex.attrs(styles.issueBodySpan4)}>{t("web.farm.plot.reviewed", { clock: wallClockText(at()) })}</span>}
                    </Show>
                  </div>
                </Row>
              </Show>
              <Show when={s().resolvedFindings.length > 0}>
                <Row label={t("web.farm.plot.weeded")}>
                  <For each={s().resolvedFindings}>{(f) => <p {...stylex.attrs(styles.issueBodyP5)}>{t("web.farm.plot.weed", { text: f.text })}</p>}</For>
                </Row>
              </Show>
              <Show when={agent()?.model}>
                {(model) => (
                  <Row label={t("web.farm.plot.model")}>
                    <p {...stylex.attrs(styles.plotDetailP)}>{model()}</p>
                  </Row>
                )}
              </Show>
              <Show when={s().head.branch}>
                <Row label={t("web.farm.plot.branch")}>
                  <p {...stylex.attrs(styles.issueBodyP42)}>{s().head.branch}</p>
                </Row>
              </Show>
              <Show when={s().head.worktree}>
                {(tree) => (
                  <Row label="worktree">
                    <div {...stylex.attrs(styles.issueBodyDiv10)}>
                      <span {...stylex.attrs(styles.issueBodySpan)}>{tree()}</span>
                      <PxButton size="sm" onClick={() => void navigator.clipboard.writeText(tree())}>
                        {t("web.farm.plot.copyPath")}
                      </PxButton>
                    </div>
                  </Row>
                )}
              </Show>
              <Row label={t("web.farm.plot.opened")}>
                <p {...stylex.attrs(styles.plotDetailP)}>{wallClockText(props.issue.createdAt)}</p>
              </Row>
              <Show when={props.issue.closedAt}>
                {(at) => (
                  <Row label={t("web.farm.plot.closed")}>
                    <p {...stylex.attrs(styles.plotDetailP)}>{wallClockText(at())}</p>
                  </Row>
                )}
              </Show>
              <Row label={t("web.farm.plot.history")}>
                <p {...stylex.attrs(styles.plotDetailP)}>{s().historyLine}</p>
              </Row>
              <Row label={t("web.farm.plot.took")}>
                <p {...stylex.attrs(styles.plotDetailP)}>{s().usedLine(steps(), now())}</p>
              </Row>
              <div {...stylex.attrs(styles.issueBodyDiv11)}>
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
    <div {...stylex.attrs(styles.asideDiv)}>
      <div {...stylex.attrs(styles.asideDiv2)}>
        <Show when={crop()}>{(c) => <img src={c().url} alt="" {...stylex.attrs(styles.asideImg)} />}</Show>
        <Show when={figure()}>{(f) => <img src={f().url} alt="" {...stylex.attrs(styles.asideImg2)} />}</Show>
      </div>
      <p {...stylex.attrs(styles.asideP2)}>{cropLabel[plot().crop]}</p>
      <p {...stylex.attrs(styles.asideP)}>
        {labelOf(speciesLabel, SpeciesValues, kind()[0] ?? "")} · {labelOf(outfitLabel, OutfitValues, kind()[1] ?? "")}
      </p>
      <p {...stylex.attrs(styles.issueBodySpan2)}>
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
    <div {...stylex.attrs(styles.issueBodyDiv9)}>
      <For each={props.rows} keyed={(r) => r.text}>
        {(r, i) => (
          <Show
            when={props.checking}
            fallback={
              <div {...stylex.attrs(styles.criteriaDiv)}>
                <span {...stylex.attrs(styles.criteriaSpan2)}>{mark(r()) ?? <span {...styleProps(styles.emptyCriterion)} />}</span>
                <span {...stylex.attrs(styles.criteriaSpan22)}>
                  <span {...stylex.attrs(styles.plotDetailP)}>{r().text}</span>
                  <Show when={r().proof}>
                    <span {...stylex.attrs(styles.criteriaSpan)}>{r().proof}</span>
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
              {...styleProps([farmGroup, styles.criterion])}
            >
              <span {...styleProps(styles.criterionBox)}>
                <Show when={ticked().has(i())}>
                  <SpriteIcon name="mark-check" size={12} label={t("web.farm.plot.ticked")} />
                </Show>
              </span>
              <span {...stylex.attrs(styles.criteriaSpan2)}>{mark(r())}</span>
              <span {...stylex.attrs(styles.criteriaSpan22)}>
                <span {...stylex.attrs(styles.plotDetailP)}>{r().text}</span>
                <Show when={r().proof}>
                  <span {...stylex.attrs(styles.criteriaSpan)}>{r().proof}</span>
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
    <div {...stylex.attrs(styles.foldDiv)}>
      <button type="button" data-testid="fold" aria-expanded={aria(open())} onClick={() => setOpen(!open())} {...styleProps([farmGroup, styles.fold])}>
        <SpriteIcon name="button-next" size={12} styles={open() && styles.foldOpen} />
        <span {...styleProps(styles.foldLabel)}>{props.label}</span>
      </button>
      {/* Mounted with the dialog and only hidden while folded. */}
      <div {...stylex.attrs(styles.foldDiv2)} hidden={!open()}>
        <Errored fallback={<p {...stylex.attrs(styles.foldP)}>{t("web.farm.unread")}</p>}>
          <Loading fallback={<p {...stylex.attrs(styles.foldP)}>{t("web.farm.reading")}</p>}>{props.children}</Loading>
        </Errored>
      </div>
    </div>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div {...stylex.attrs(styles.rowDiv)}>
      <span {...stylex.attrs(styles.rowSpan)}>{props.label}</span>
      <div {...stylex.attrs(styles.criteriaSpan22)}>{props.children}</div>
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
    <Show when={runs().length > 0} fallback={<p {...stylex.attrs(styles.issueBodySpan2)}>{t("web.farm.plot.noRuns")}</p>}>
      <FarmSection title={t("web.farm.plot.runs")}>
        <p {...stylex.attrs(styles.issueBodySpan2)}>{t("web.farm.plot.runCount", { n: runs().length })}</p>
        <For each={[...runs()].toReversed()} keyed={(r) => r.id}>
          {(r) => (
            <Row label={wallClockText(r().startedAt)}>
              <p {...stylex.attrs(styles.plotDetailP)}>{runText(r(), now(), tookText)}</p>
            </Row>
          )}
        </For>
      </FarmSection>
    </Show>
  );
}
