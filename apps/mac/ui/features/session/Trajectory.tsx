import { Scroll, signal, Text, View, type JSX, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Session, SessionEvent, SessionTrajectoryProjection, TrajectoryStepMeta } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Quiet } from "../../design/layout";
import { motionClass } from "../../design/motion";
import { Dot } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { mix, tone } from "../../design/tone";
import { useNow } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { createMemo } from "../../infra/solid";
import { createSessionProjection } from "./events";
import { collapsedStepSummary, lastTime, localizeCollapsedSummary, projectTrajectory, runMs, secondsText, spanTone, tagOf, tokensText } from "./runs";
import { SubagentProgress } from "./SubagentProgress";
import { Markable } from "./trajectory/Markable";
import {
  emptySummary,
  haystack,
  isErrorStep,
  type MarkWrong,
  matchesStepFilter,
  type RowSpec,
  type RunGroup,
  type StepFilter,
  stepFilterLabel,
  stepFilters,
  stepTextOf,
  summaryText,
} from "./trajectory/model";
import { Row } from "./trajectory/StepRow";
import { WaterfallView } from "./trajectory/WaterfallView";

/** A session's (or the orchestrator's) trajectory, read and then followed live. */
export function TrajectoryLog(props: {
  id: string;
  asked?: string;
  empty?: string;
  working?: boolean;
  onMarkWrong?: MarkWrong;
  title?: string;
  about?: string;
  subagents?: Session["subagents"];
}) {
  const proj = createSessionProjection(
    () => props.id,
    () => true,
  );
  const now = useNow();
  const head = () => (
    <If when={props.title}>
      {(title) => (
        <View tooltip={<If when={props.about}>{(about) => <Bubble text={about()} />}</If>}>
          <Text class="truncate text-sm font-semibold text-ink">{title()}</Text>
        </View>
      )}
    </If>
  );
  return (
    <View class="min-h-0 flex-1">
      <If when={props.subagents}>{(progress) => <SubagentProgress session={props.id} progress={progress()} now={now()} />}</If>
      <If
        when={proj().steps.length > 0}
        else={
          <View class="gap-2">
            {head()}
            <Quiet>{props.empty ?? t("web.session.trajectory.quiet")}</Quiet>
          </View>
        }
      >
        <Trajectory
          steps={proj().steps}
          trajectory={proj().trajectory}
          now={now()}
          asked={props.asked}
          working={props.working === true}
          onMarkWrong={props.onMarkWrong}
          head={head()}
        />
      </If>
    </View>
  );
}

export function Trajectory(props: {
  steps: SessionEvent[];
  trajectory?: SessionTrajectoryProjection | undefined;
  now: number;
  asked?: string | undefined;
  working?: boolean;
  onMarkWrong?: MarkWrong | undefined;
  head?: JSX.Element;
}) {
  const query = signal("");
  const stepFilter = signal<StepFilter>("all");
  const open = signal<ReadonlySet<number>>(new Set());
  const collapsedRuns = signal<ReadonlySet<string>>(new Set());
  const marked = signal<number>();
  // The messages marked wrong here, by their step: the case's file.
  const wrong = signal<ReadonlyMap<number, string>>(new Map());
  const rowRefs = new Map<number, ViewRef>();

  const end = createMemo(() => {
    const last = props.steps.at(-1)?.time ?? props.now;
    return props.working === true && props.now > last ? props.now : last;
  });
  const activeProj = createMemo(() => props.trajectory ?? projectTrajectory(props.steps, end()));
  const shown = createMemo(() => activeProj()?.shown ?? []);
  const errorCount = createMemo(() => shown().filter(isErrorStep).length);
  const hasActiveFilter = createMemo(() => query().trim().length > 0 || stepFilter() !== "all");
  const clearFilters = () => {
    query.set("");
    stepFilter.set("all");
  };
  const bySeq = createMemo(() => new Map(shown().map((s) => [s.seq, s])));
  const metaBySeq = createMemo((): ReadonlyMap<number, TrajectoryStepMeta> => new Map((activeProj()?.stepMeta ?? []).map((m) => [m.seq, m])));
  const durations = createMemo(() => new Map((activeProj()?.stepDurations ?? []).map((d) => [d.seq, d.durationMs])));
  const summary = createMemo(() => summaryText(activeProj()?.summary ?? emptySummary));

  const groups = createMemo((): readonly RunGroup[] => {
    const firstAsked = shown().find((s) => s.type === "user/message" && s.under === undefined)?.seq;
    const filter = stepFilter();
    const q = query().trim().toLowerCase();
    const views = activeProj()?.runs ?? [];
    const durationMap = durations();
    const metaMap = metaBySeq();
    const out: RunGroup[] = [];
    let n = 0;
    views.forEach((view, idx) => {
      if (view.run !== undefined) n++;
      const allSteps = view.asked ? [view.asked, ...view.steps] : view.steps;
      const rows: RowSpec[] = [];
      for (const step of allSteps) {
        if (!matchesStepFilter(step, filter)) continue;
        const tag = tagOf(step, props.asked, step.seq === firstAsked);
        if (q && !haystack(step, tag).includes(q)) continue;
        const meta = metaMap.get(step.seq);
        rows.push({
          step,
          tag,
          when: ago(step.time, props.now),
          durationMs: durationMap.get(step.seq),
          readableInput: meta?.readableInput,
          collapsedSummary: meta?.collapsedSummary,
          markable: !!props.onMarkWrong && step.type === "user/message" && step.under === undefined,
        });
      }
      if (rows.length === 0) return;
      const isLast = idx === views.length - 1;
      const isLive = props.working === true && isLast;
      const runEnd = isLive ? end() : (lastTime(view) ?? end());
      const firstStep = allSteps.at(0);
      const toolsCount = allSteps.filter((s) => s.type === "tool/call").length;
      let tokIn = 0;
      let tokOut = 0;
      for (const s of allSteps) {
        if (s.tokens) {
          tokIn += Math.round(s.tokens.input + s.tokens.cacheRead);
          tokOut += Math.round(s.tokens.output);
        }
      }
      out.push({
        key: view.run ?? `earlier-${firstStep?.seq ?? idx}`,
        label: view.run !== undefined ? t("web.session.trajectory.run", { n }) : t("web.session.trajectory.earlier"),
        when: firstStep !== undefined ? ago(firstStep.time, props.now) : "",
        took: secondsText(runMs(view, runEnd)),
        stepsCount: allSteps.filter((s) => s.type !== "llm/usage").length,
        toolsCount,
        tokens: tokIn + tokOut > 0 ? `${tokensText(tokIn)}/${tokensText(tokOut)}` : undefined,
        live: isLive,
        hasError: allSteps.some((s) => s.type === "run/error"),
        rows,
      });
    });
    return out;
  });

  const visibleSeqs = createMemo(() => groups().flatMap((g) => g.rows.map((r) => r.step.seq)));
  const allExpanded = createMemo(() => {
    const seqs = visibleSeqs();
    if (seqs.length === 0) return false;
    const closed = collapsedRuns();
    const opened = open();
    return groups().every((g) => hasActiveFilter() || !closed.has(g.key)) && seqs.every((seq) => opened.has(seq));
  });

  const toggleAll = () => {
    if (allExpanded()) {
      open.set(new Set());
      return;
    }
    collapsedRuns.set(new Set());
    open.set(new Set(visibleSeqs()));
  };

  const show = (seq: number) => {
    clearFilters();
    const targetGroup = groups().find((g) => g.rows.some((r) => r.step.seq === seq));
    if (targetGroup && collapsedRuns().has(targetGroup.key)) {
      collapsedRuns.set(new Set([...collapsedRuns()].filter((k) => k !== targetGroup.key)));
    }
    const o = open();
    if (!o.has(seq)) open.set(new Set([...o, seq]));
    marked.set(seq);
    requestAnimationFrame(() => rowRefs.get(seq)?.reveal({ vertical: "nearest" }));
  };

  const toggle = (n: number) => {
    const o = open();
    open.set(o.has(n) ? new Set([...o].filter((x) => x !== n)) : new Set([...o, n]));
  };

  const toggleRun = (key: string) => {
    const c = collapsedRuns();
    collapsedRuns.set(c.has(key) ? new Set([...c].filter((k) => k !== key)) : new Set([...c, key]));
  };

  return (
    <View testID="trajectory" class="min-h-0 flex-1">
      <View class="flex-row flex-wrap items-center gap-2 pb-2">
        <View class="min-w-0 flex-1">{props.head}</View>
        <View testID="trajectory-filters" class="flex-row items-center gap-0.5 rounded-md border border-line bg-side p-0.5">
          <Each of={stepFilters} key={(f) => f}>
            {(f) => {
              const active = () => stepFilter() === f();
              const hasErrors = () => f() === "errors" && errorCount() > 0;
              const label = () => (hasErrors() ? `${stepFilterLabel(f())} (${errorCount()})` : stepFilterLabel(f()));
              return (
                <View
                  role="button"
                  testID={`trajectory-filter-${f()}`}
                  accessibilityState={{ selected: active() }}
                  onPress={() => stepFilter.set(f())}
                  class={`h-6 flex-row items-center rounded-sm px-2 focus-visible:outline-2 focus-visible:outline-focus ${
                    active() ? "bg-page shadow-raise" : "hover:bg-hover"
                  }`}
                >
                  <Text
                    class={`text-xs ${active() ? (hasErrors() ? "font-medium text-berry" : "font-medium text-ink") : hasErrors() ? "text-berry" : "text-muted"}`}
                  >
                    {label()}
                  </Text>
                </View>
              );
            }}
          </Each>
        </View>
        <If when={visibleSeqs().length > 0}>
          <Button size="compact" testID="trajectory-toggle-all" icon={allExpanded() ? "collapseAll" : "expandAll"} onPress={toggleAll}>
            {allExpanded() ? t("web.session.trajectory.collapseAll") : t("web.session.trajectory.expandAll")}
          </Button>
        </If>
        <SearchField
          testid="trajectory-search"
          clearTestid="trajectory-search-clear"
          clearLabel={t("web.session.hub.clear")}
          value={query()}
          onInput={(v) => query.set(v)}
          placeholder={t("web.session.trajectory.searchHint")}
          label={t("web.session.trajectory.search")}
          class="w-48"
        />
      </View>
      <WaterfallView
        steps={props.steps}
        waterfall={activeProj()?.waterfall}
        end={end()}
        selectedSeq={marked()}
        colorOf={(seq) => {
          const s = bySeq().get(seq);
          return s ? tone(spanTone(s)) : tone("bark-400");
        }}
        summaryOf={(seq) => {
          const s = bySeq().get(seq);
          if (!s) return "";
          const pre = metaBySeq().get(seq)?.collapsedSummary;
          if (pre !== undefined) return localizeCollapsedSummary(pre);
          return collapsedStepSummary(s, stepTextOf(s));
        }}
        onPick={show}
      />
      <Scroll class="mt-2 min-h-0 flex-1" contentClass="pb-2">
        <If
          when={groups().length > 0}
          else={
            <View class="items-start gap-2 rounded-lg border border-line bg-elevated px-3.5 py-4">
              <Text testID="steps-empty" class="text-sm text-muted">
                {t("web.session.trajectory.noMatch")}
              </Text>
              <If when={hasActiveFilter()}>
                <Button size="compact" icon="refresh" testID="trajectory-clear-filters" onPress={clearFilters}>
                  {t("web.session.hub.clearFilter")}
                </Button>
              </If>
            </View>
          }
        >
          <Each of={groups()} key={(g) => g.key}>
            {(group) => {
              const isRunOpen = () => hasActiveFilter() || !collapsedRuns().has(group().key);
              const metaParts = () => {
                const g = group();
                return [
                  t("web.session.trajectory.steps", { n: g.stepsCount }),
                  ...(g.toolsCount > 0 ? [t("web.session.runs.usedTools", { n: g.toolsCount })] : []),
                  g.took,
                  ...(g.tokens !== undefined ? [g.tokens] : []),
                ];
              };
              return (
                <View testID={`run-group-${group().key}`} class="mb-2.5 overflow-hidden rounded-lg border border-line bg-elevated">
                  <View
                    role="button"
                    testID={`run-header-${group().key}`}
                    accessibilityState={{ expanded: isRunOpen() }}
                    accessibilityLabel={isRunOpen() ? t("web.session.log.fold") : t("web.session.log.unfold")}
                    onPress={() => toggleRun(group().key)}
                    class={`h-8 flex-row items-center gap-2 bg-side px-3 focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover ${
                      isRunOpen() ? "border-b border-line" : "border-b-0"
                    }`}
                  >
                    <View
                      class={`h-3.5 w-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
                      style={{ transform: [{ rotate: isRunOpen() ? "90deg" : "0deg" }] }}
                    >
                      <Icon name="expand" size={10} tone="muted" />
                    </View>
                    <View class="h-3.5 w-3.5 shrink-0 items-center justify-center">
                      <If
                        when={group().live}
                        else={
                          <If when={group().hasError} else={<Icon name="check" size={12} />}>
                            <Icon name="cross" size={12} />
                          </If>
                        }
                      >
                        <Dot tone="water" size={7} ring={false} />
                      </If>
                    </View>
                    <Text class="shrink-0 text-xs font-semibold text-ink">{group().label}</Text>
                    <Text
                      class={`min-w-0 flex-1 truncate text-2xs tabular-nums ${group().live ? "font-medium text-water" : group().hasError ? "text-berry" : "text-muted"}`}
                    >
                      {metaParts().join(" · ")}
                    </Text>
                    <If when={group().when}>
                      <Text class="shrink-0 text-right text-2xs text-faint tabular-nums">{group().when}</Text>
                    </If>
                  </View>
                  <If when={isRunOpen()}>
                    <View>
                      <Each of={group().rows} key={(r) => r.step.seq}>
                        {(r, rowIdx) => {
                          const hasDivider = () => rowIdx() < group().rows.length - 1;
                          const row = () => (
                            <Row
                              spec={r()}
                              open={open().has(r().step.seq)}
                              marked={marked() === r().step.seq}
                              refTo={(el) => rowRefs.set(r().step.seq, el)}
                              onToggle={() => toggle(r().step.seq)}
                            />
                          );
                          return (
                            <View class={hasDivider() ? "border-b" : ""} style={hasDivider() ? { borderColor: mix("line", 0.45) } : undefined}>
                              <If when={r().markable ? props.onMarkWrong : undefined} else={row()}>
                                {(send) => (
                                  <Markable
                                    step={r().step.seq}
                                    send={send()}
                                    file={wrong().get(r().step.seq)}
                                    onMarked={(file) => wrong.set(new Map([...wrong(), [r().step.seq, file]]))}
                                  >
                                    {row()}
                                  </Markable>
                                )}
                              </If>
                            </View>
                          );
                        }}
                      </Each>
                    </View>
                  </If>
                </View>
              );
            }}
          </Each>
        </If>
      </Scroll>
      <View class="shrink-0 border-t border-line pt-2">
        <Text testID="trajectory-summary" class="text-xs text-muted tabular-nums">
          {summary()}
        </Text>
      </View>
    </View>
  );
}
