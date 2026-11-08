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
import { tint } from "#/farm/panels/rows.tsx";
import { farm, farmActWords, overlayOf, useFarm } from "#/farm/store.ts";
import { useVillage } from "#/farm/world/load.ts";
import { cropLabel, issueOf, plotOf, stationOfSession } from "#/farm/world/plots.ts";
import { issueThreadOf } from "#/features/channel/index.ts";
import {
  createIssueActs,
  changesLine,
  issueDeliver,
  issueMove,
  issueMoveOf,
  sendMove,
  shownDeliver,
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
import { sendReplacing, useIntents } from "#/state/intent.ts";
import { castPrefix, outfitLabel, speciesLabel } from "#/ui/cast.ts";
import { createPixelAct, FarmDialog, FarmSection, PxButton, PxTextArea, SpriteIcon, toasts, ToastType } from "#/ui/pixel/index.ts";

const recipeStyles2 = stylex.create({
  issueBodySpan: {
    minWidth: "0",
    flex: "1",
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    wordBreak: "break-all",
    WebkitUserSelect: "text",
    userSelect: "text",
  },
});

const recipeStyles = stylex.create({
  plotDetailP: {
    fontSize: "13px",
    lineHeight: "1.5",
    color: "var(--color-bark-800)",
  },
  issueBodySpan: {
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  issueBodyP: {
    marginTop: "var(--spacing)",
    WebkitLineClamp: "4",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "13px",
    lineHeight: "1.5",
    whiteSpace: "pre-wrap",
    color: "var(--color-bark-800)",
  },
  issueBodySpan2: {
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
  issueBodyPVariant1Case1: {
    color: "var(--color-bark-800)",
  },
  issueBodyPVariant1Case2: {
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
});

const variantStyles = stylex.create({
  issueBodyDiv: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  issueBodySpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  issueBodySpanVariant: {
    color: "var(--color-berry)",
  },
  issueBodySpanVariant2: {
    color: "var(--color-bark-600)",
  },
  issueBodySpan2: {},
});

const viewStyles = stylex.create({
  issueBodyDiv: {
    display: "flex",
    flexDirection: {
      default: "column",
      "@media (width>=40rem)": "row",
    },
    gap: "calc(var(--spacing) * 4)",
    alignItems: {
      default: null,
      "@media (width>=40rem)": "flex-start",
    },
  },
  issueBodyDiv2: {
    display: "flex",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 2)",
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
    marginTop: "var(--spacing)",
    fontSize: "13px",
  },
  issueBodyDiv3: {
    marginTop: "calc(var(--spacing) * 3)",
    padding: "calc(var(--spacing) * 3)",
  },
  issueBodyP: {
    fontSize: "14px",
  },
  issueBodyDiv4: {
    marginTop: "calc(var(--spacing) * 2)",
  },
  issueBodyDiv5: {
    marginTop: "calc(var(--spacing) * 1.5)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 1.5)",
  },
  issueMove: {
    marginTop: "calc(var(--spacing) * 2)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "12px",
  },
  issueBodyDiv6: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  issueBodyDiv7: {
    marginTop: "calc(var(--spacing) * 1.5)",
  },
  issueBodyDiv8: {
    marginTop: "calc(var(--spacing) * 4)",
  },
  issueBodyDiv9: {
    display: "flex",
    flexDirection: "column",
  },
  issueBodyP2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    color: "var(--color-bark-800)",
  },
  issueBodyP3: {
    fontSize: "13px",
    whiteSpace: "pre-wrap",
    color: "var(--color-bark-800)",
  },
  plotDeliver: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  issueBodySpan: {
    fontSize: "12px",
    color: "var(--color-leaf-700)",
  },
  issueBodyP4: {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    color: "var(--color-bark-800)",
  },
  issueBodyDiv10: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  issueBodyDiv11: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  asideDiv: {
    display: "flex",
    width: {
      default: "100%",
      "@media (width>=40rem)": "calc(var(--spacing) * 52)",
    },
    flexShrink: "0",
    flexDirection: "column",
    alignItems: "center",
    backgroundColor: "var(--color-cream-100)",
    padding: "calc(var(--spacing) * 3)",
  },
  asideDiv2: {
    position: "relative",
    display: "flex",
    height: "calc(var(--spacing) * 44)",
    width: "calc(var(--spacing) * 44)",
    alignItems: "flex-end",
    justifyContent: "center",
  },
  asideImg: {
    position: "absolute",
    bottom: "0",
    width: "calc(var(--spacing) * 44)",
    opacity: ".9",
    imageRendering: "pixelated",
  },
  asideImg2: {
    position: "relative",
    height: "calc(var(--spacing) * 36)",
    imageRendering: "pixelated",
  },
  asideP: {
    marginTop: "calc(var(--spacing) * 2)",
    fontSize: "13px",
  },
  criteriaDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
  },
  criteriaSpan: {
    marginTop: "calc(var(--spacing) * .5)",
    display: "flex",
    height: "calc(var(--spacing) * 4)",
    width: "calc(var(--spacing) * 4)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
  },
  criteriaSpan2: {
    minWidth: "0",
    flex: "1",
  },
  foldDiv: {
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-cream-300)",
  },
  foldDiv2: {
    paddingBottom: "calc(var(--spacing) * 3)",
  },
  foldP: {
    fontSize: "12px",
    color: "var(--color-bark-500)",
  },
  rowDiv: {
    marginBottom: "calc(var(--spacing) * 2)",
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 3)",
  },
  rowSpan: {
    width: "72px",
    flexShrink: "0",
    fontSize: "13px",
    color: "var(--color-bark-500)",
  },
});

const tones: Record<string, string> = { berry: "#c84a3a", wheat: "#e5a93c", water: "#4f8fbd", leaf: "#74a046", faint: "#c8a46e", muted: "#9b7550" };

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
    <Show when={issue()} fallback={<p {...stylex.attrs(recipeStyles.plotDetailP)}>{t("web.farm.plot.unread")}</p>}>
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

  const delivers = useIntents(issueDeliver);
  const deliver = () => shownDeliver(props.issue.id, props.issue.deliver, delivers.list());
  const setDeliver = (d: Deliverable) => sendReplacing(delivers, { id: props.issue.id, deliver: d }, (a, b) => a.id === b.id);
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
    <div {...stylex.attrs(viewStyles.issueBodyDiv)}>
      <Aside session={s().head} agent={agent()} />
      <div {...stylex.attrs(variantStyles.issueBodyDiv)}>
        <div {...stylex.attrs(viewStyles.issueBodyDiv2)}>
          <span {...stylex.attrs(recipeStyles.issueBodySpan)}>#{props.issue.number}</span>
          <h3 {...stylex.attrs(viewStyles.issueBodyH3)} title={s().title}>
            {s().title}
          </h3>
          <Show when={s().repo}>
            <span {...stylex.attrs(recipeStyles.issueBodySpan)}>{s().repo}</span>
          </Show>
        </div>
        <p
          {...stylex.attrs(viewStyles.issueNow)}
          style={{ color: s().stage.state === "stuck" ? tones.berry : "#5a3d26" }}
          aria-label={t("web.farm.plot.now")}
          data-testid="issue-now"
          data-state={s().stage.state}
        >
          {s().statusLine(now(), timeline()?.spent?.cny)}
        </p>

        <Show when={s().ask}>
          {(ask) => (
            <div
              {...stylex.attrs(viewStyles.issueBodyDiv3)}
              style={{ background: tint(tones[ask().tone] ?? "#c8a46e", 0.3) }}
              aria-label={t("web.farm.plot.yours")}
              role="region"
            >
              <p {...stylex.attrs(viewStyles.issueBodyP)}>{ask().head}</p>
              <Show when={ask().line}>
                <p {...stylex.attrs(recipeStyles.issueBodyP)}>{ask().line}</p>
              </Show>
              <Show when={state() === "asking"}>
                <For each={props.issue.questions}>
                  {(q) => (
                    <div {...stylex.attrs(viewStyles.issueBodyDiv4)}>
                      <p {...stylex.attrs(recipeStyles.plotDetailP)}>{q.question}</p>
                      <Show when={q.options.length}>
                        <div {...stylex.attrs(viewStyles.issueBodyDiv5)} role="group" aria-label={t("web.farm.plot.answerTo", { question: q.question })}>
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
          <div {...stylex.attrs(viewStyles.issueBodyDiv4)}>
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
            <div data-testid="issue-move" data-state={m().state} {...stylex.attrs(viewStyles.issueMove)}>
              <span
                {...stylex.attrs(
                  variantStyles.issueBodySpan,
                  m().state === "failed" ? variantStyles.issueBodySpanVariant : variantStyles.issueBodySpanVariant2,
                )}
                title={m().reason}
              >
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
            <div data-testid="issue-said" data-key={w().key} data-state={w().state} {...stylex.attrs(viewStyles.issueMove)}>
              <span {...stylex.attrs(recipeStyles.issueBodySpan2)}>{w().text}</span>
              <span
                {...stylex.attrs(
                  variantStyles.issueBodySpan2,
                  w().state === "failed" ? variantStyles.issueBodySpanVariant : variantStyles.issueBodySpanVariant2,
                )}
                title={w().reason}
              >
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
        <div {...stylex.attrs(viewStyles.issueBodyDiv6)}>
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
            <p {...stylex.attrs(recipeStyles.issueBodyP2)}>{s().doing}</p>
          </Show>
          <Show when={s().inFamily}>
            <p {...stylex.attrs(recipeStyles.issueBodySpan)}>{s().parentText}</p>
          </Show>
          <Show
            when={s().criteria.length > 0}
            fallback={<p {...stylex.attrs(recipeStyles.issueBodySpan)}>{t("web.farm.plot.noCriteria", { answer: props.issue.deliver === "answer" })}</p>}
          >
            <Criteria rows={s().criteria} checking={state() === "reviewing" && props.issue.reviewedAt === undefined} />
          </Show>
          <Show when={s().openFindings.length > 0}>
            <div {...stylex.attrs(viewStyles.issueBodyDiv7)}>
              <For each={s().openFindings}>{(f) => <p {...stylex.attrs(recipeStyles.issueBodyP3)}>{t("web.farm.plot.rejected", { text: f.text })}</p>}</For>
            </div>
          </Show>
        </FarmSection>

        <div {...stylex.attrs(viewStyles.issueBodyDiv8)}>
          <Show when={props.issue.deliver === "answer" ? props.issue.answer : undefined}>
            {(a) => (
              <FarmSection title={t("web.farm.plot.conclusion")}>
                <p {...stylex.attrs(recipeStyles.plotDetailP)}>{a().conclusion}</p>
                <For each={a().evidence}>{(l) => <p {...stylex.attrs(recipeStyles.issueBodySpan)}>{t("web.farm.plot.evidence", { line: l })}</p>}</For>
                <For each={a().next}>{(l) => <p {...stylex.attrs(recipeStyles.issueBodySpan)}>{t("web.farm.plot.next", { line: l })}</p>}</For>
              </FarmSection>
            )}
          </Show>
          <Show when={s().showsChanges && props.issue.deliver !== "answer"}>
            <Fold label={madeLabel()}>
              <Show
                when={changed()}
                fallback={
                  <p {...stylex.attrs(recipeStyles.plotDetailP)}>{changes.status() === "pending" ? t("web.farm.reading") : t("web.farm.plot.changesUnread")}</p>
                }
              >
                {(c) => (
                  <div {...stylex.attrs(viewStyles.issueBodyDiv9)}>
                    <p {...stylex.attrs(recipeStyles.plotDetailP)}>{changesLine(c())}</p>
                    <Show when={c().conflicts.length > 0}>
                      <p {...stylex.attrs(recipeStyles.issueBodyP3)}>{t("web.farm.plot.conflict", { base: c().base, files: list(c().conflicts) })}</p>
                    </Show>
                    <div {...stylex.attrs(viewStyles.issueBodyDiv7)}>
                      <For each={c().files.slice(0, 12)}>
                        {(f) => (
                          <p {...stylex.attrs(viewStyles.issueBodyP2)}>
                            {f.path} +{Math.round(f.added)} -{Math.round(f.removed)}
                          </p>
                        )}
                      </For>
                      <Show when={c().files.length > 12}>
                        <p {...stylex.attrs(recipeStyles.issueBodySpan)}>{t("web.farm.plot.moreFiles", { n: c().files.length - 12 })}</p>
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
                <p {...stylex.attrs(recipeStyles.issueBodySpan)}>{timelineQuery.status() === "pending" ? t("web.farm.reading") : t("web.farm.unread")}</p>
              }
            >
              {(line) => (
                <For each={line().milestones}>
                  {(m) => (
                    <Row label={wallClockText(m.at)}>
                      <p
                        {...stylex.attrs(
                          recipeStyles.issueBodyP4,
                          m.kind === "failed" || m.kind === "rejected" ? recipeStyles.issueBodyPVariant1Case2 : recipeStyles.issueBodyPVariant1Case1,
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
            <Show when={steps().length > 0} fallback={<p {...stylex.attrs(recipeStyles.issueBodySpan)}>{noStepsText(s().head)}</p>}>
              <WorkLog steps={steps()} now={now()} working={state() === "working"} />
            </Show>
          </Fold>
          <Fold label={t("web.farm.plot.runs")}>
            <Runs issue={props.issue.id} version={`${sessionIdsOf(props.issue).length}:${s().head.runs}:${s().head.phase._tag}`} />
          </Fold>
          <Fold label={t("web.farm.plot.details")}>
            <div {...stylex.attrs(viewStyles.issueBodyDiv9)}>
              <Show when={s().description}>
                <Row label={t("web.farm.plot.job")}>
                  <p {...stylex.attrs(viewStyles.issueBodyP3)}>{s().description}</p>
                </Row>
              </Show>
              <Row label={t("web.farm.plot.who")}>
                <p {...stylex.attrs(recipeStyles.plotDetailP)}>{s().whoLine}</p>
              </Row>
              <Show when={s().crewLine}>
                <Row label={t("web.farm.plot.crew")}>
                  <p {...stylex.attrs(recipeStyles.plotDetailP)}>{s().crewLine}</p>
                </Row>
              </Show>
              <Show when={!s().inFamily}>
                <Row label={t("web.farm.plot.deliver")}>
                  <div {...stylex.attrs(viewStyles.plotDeliver)} data-testid="plot-deliver" data-value={deliver().value} data-state={deliver().state}>
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
                      {(at) => <span {...stylex.attrs(viewStyles.issueBodySpan)}>{t("web.farm.plot.reviewed", { clock: wallClockText(at()) })}</span>}
                    </Show>
                  </div>
                </Row>
              </Show>
              <Show when={s().resolvedFindings.length > 0}>
                <Row label={t("web.farm.plot.weeded")}>
                  <For each={s().resolvedFindings}>{(f) => <p {...stylex.attrs(recipeStyles.issueBodyP5)}>{t("web.farm.plot.weed", { text: f.text })}</p>}</For>
                </Row>
              </Show>
              <Show when={agent()?.model}>
                <Row label={t("web.farm.plot.model")}>
                  <p {...stylex.attrs(recipeStyles.plotDetailP)}>{agent()!.model}</p>
                </Row>
              </Show>
              <Show when={s().head.branch}>
                <Row label={t("web.farm.plot.branch")}>
                  <p {...stylex.attrs(viewStyles.issueBodyP4)}>{s().head.branch}</p>
                </Row>
              </Show>
              <Show when={s().head.worktree}>
                {(tree) => (
                  <Row label="worktree">
                    <div {...stylex.attrs(viewStyles.issueBodyDiv10)}>
                      <span {...stylex.attrs(recipeStyles2.issueBodySpan)}>{tree()}</span>
                      <PxButton size="sm" onClick={() => void navigator.clipboard.writeText(tree())}>
                        {t("web.farm.plot.copyPath")}
                      </PxButton>
                    </div>
                  </Row>
                )}
              </Show>
              <Row label={t("web.farm.plot.opened")}>
                <p {...stylex.attrs(recipeStyles.plotDetailP)}>{wallClockText(props.issue.createdAt)}</p>
              </Row>
              <Show when={props.issue.closedAt}>
                {(at) => (
                  <Row label={t("web.farm.plot.closed")}>
                    <p {...stylex.attrs(recipeStyles.plotDetailP)}>{wallClockText(at())}</p>
                  </Row>
                )}
              </Show>
              <Row label={t("web.farm.plot.history")}>
                <p {...stylex.attrs(recipeStyles.plotDetailP)}>{s().historyLine}</p>
              </Row>
              <Row label={t("web.farm.plot.took")}>
                <p {...stylex.attrs(recipeStyles.plotDetailP)}>{s().usedLine(steps(), now())}</p>
              </Row>
              <div {...stylex.attrs(viewStyles.issueBodyDiv11)}>
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
    <div {...stylex.attrs(viewStyles.asideDiv)}>
      <div {...stylex.attrs(viewStyles.asideDiv2)}>
        <Show when={crop()}>{(c) => <img src={c().url} alt="" {...stylex.attrs(viewStyles.asideImg)} />}</Show>
        <Show when={figure()}>{(f) => <img src={f().url} alt="" {...stylex.attrs(viewStyles.asideImg2)} />}</Show>
      </div>
      <p {...stylex.attrs(viewStyles.asideP)}>{cropLabel[plot().crop]}</p>
      <p {...stylex.attrs(recipeStyles.asideP)}>
        {labelOf(speciesLabel, SpeciesValues, kind()[0] ?? "")} · {labelOf(outfitLabel, OutfitValues, kind()[1] ?? "")}
      </p>
      <p {...stylex.attrs(recipeStyles.issueBodySpan)}>
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

/** The criteria with the helper's word on each; while it is judged, each can be ticked off as the owner checks it (on
 * this page only). */
function Criteria(props: { rows: CriterionRow[]; checking: boolean }) {
  const [ticked, setTicked] = createSignal<ReadonlySet<number>>(new Set());
  const mark = (r: CriterionRow) => (r.result ? <SpriteIcon name={resultMark[r.result].icon} size={14} label={resultMark[r.result].label} /> : undefined);
  return (
    <div {...stylex.attrs(viewStyles.issueBodyDiv9)}>
      <For each={props.rows} keyed={(r) => r.text}>
        {(r, i) => (
          <Show
            when={props.checking}
            fallback={
              <div {...stylex.attrs(viewStyles.criteriaDiv)}>
                <span {...stylex.attrs(viewStyles.criteriaSpan)}>{mark(r()) ?? <span class="border-bark-300 h-2.5 w-2.5 border-2" />}</span>
                <span {...stylex.attrs(viewStyles.criteriaSpan2)}>
                  <span {...stylex.attrs(recipeStyles.plotDetailP)}>{r().text}</span>
                  <Show when={r().proof}>
                    <span {...stylex.attrs(recipeStyles.criteriaSpan)}>{r().proof}</span>
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
              class="group flex cursor-pointer items-start gap-2 py-0.5 text-left"
            >
              <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border-2 border-bark-400 bg-cream-50 group-hover:border-bark-600">
                <Show when={ticked().has(i())}>
                  <SpriteIcon name="mark-check" size={12} label={t("web.farm.plot.ticked")} />
                </Show>
              </span>
              <span {...stylex.attrs(viewStyles.criteriaSpan)}>{mark(r())}</span>
              <span {...stylex.attrs(viewStyles.criteriaSpan2)}>
                <span {...stylex.attrs(recipeStyles.plotDetailP)}>{r().text}</span>
                <Show when={r().proof}>
                  <span {...stylex.attrs(recipeStyles.criteriaSpan)}>{r().proof}</span>
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
    <div {...stylex.attrs(viewStyles.foldDiv)}>
      <button
        type="button"
        data-testid="fold"
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        class="group flex w-full cursor-pointer items-center gap-1.5 py-2 text-left"
      >
        <SpriteIcon name="button-next" size={12} class={open() ? "rotate-90" : ""} />
        <span class="text-[13px] text-bark-800 group-hover:text-bark-900">{props.label}</span>
      </button>
      {/* Mounted with the dialog and only hidden while folded. */}
      <div {...stylex.attrs(viewStyles.foldDiv2)} hidden={!open()}>
        <Errored fallback={<p {...stylex.attrs(viewStyles.foldP)}>{t("web.farm.unread")}</p>}>
          <Loading fallback={<p {...stylex.attrs(viewStyles.foldP)}>{t("web.farm.reading")}</p>}>{props.children}</Loading>
        </Errored>
      </div>
    </div>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div {...stylex.attrs(viewStyles.rowDiv)}>
      <span {...stylex.attrs(viewStyles.rowSpan)}>{props.label}</span>
      <div {...stylex.attrs(viewStyles.criteriaSpan2)}>{props.children}</div>
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
    <Show when={runs().length > 0} fallback={<p {...stylex.attrs(recipeStyles.issueBodySpan)}>{t("web.farm.plot.noRuns")}</p>}>
      <FarmSection title={t("web.farm.plot.runs")}>
        <p {...stylex.attrs(recipeStyles.issueBodySpan)}>{t("web.farm.plot.runCount", { n: runs().length })}</p>
        <For each={[...runs()].toReversed()} keyed={(r) => r.id}>
          {(r) => (
            <Row label={wallClockText(r().startedAt)}>
              <p {...stylex.attrs(recipeStyles.plotDetailP)}>{runText(r(), now(), tookText)}</p>
            </Row>
          )}
        </For>
      </FarmSection>
    </Show>
  );
}
