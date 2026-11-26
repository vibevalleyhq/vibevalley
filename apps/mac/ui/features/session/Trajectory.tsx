import { Clipboard, colorScheme, Scroll, signal, Text, View, type JSX, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { OrchestratorEval, Session, SessionEvent } from "@vibevalley/protocol";
import { oneLine } from "@vibevalley/protocol/rules";

import { createAct } from "../../design/act";
import { Button, ButtonLink } from "../../design/Button";
import { SearchField, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Quiet } from "../../design/layout";
import { Markdown } from "../../design/Markdown";
import { motionClass } from "../../design/motion";
import { Dot } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { mix, tone } from "../../design/tone";
import { useNow } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { useTimeout } from "../../infra/base/timer";
import { localizeRuntimeError } from "../../infra/runtimeError";
import { createEffect, createMemo } from "../../infra/solid";
import { createSessionEvents } from "./events";
import {
  cacheHit,
  collapsedStepSummary,
  farmToolText,
  type Lane,
  lanes,
  lastTime,
  readableInput,
  runMs,
  runsOf,
  secondsText,
  shownEvents,
  spanTone,
  stepDurationsOf,
  summaryOf,
  tagOf,
  tokensText,
  type TrajectorySummary,
  waterfallOf,
  waterfallWidths,
} from "./runs";
import { SubagentProgress } from "./SubagentProgress";

/** Saves the model turn its user/message `step` began as a case of the orchestrator's evals; `want` is what it should have done. */
type MarkWrong = (step: number, want: string) => Promise<OrchestratorEval>;

const laneNames: Record<Lane, string> = {
  asked: t("web.session.trajectory.lane.asked"),
  model: t("web.session.trajectory.lane.model"),
  tool: t("web.session.trajectory.lane.tool"),
};

type StepFilter = "all" | "tools" | "errors";

const stepFilters: readonly StepFilter[] = ["all", "tools", "errors"];

function stepFilterLabel(kind: StepFilter): string {
  switch (kind) {
    case "all":
      return t("web.session.hub.scope.all");
    case "tools":
      return t("web.session.runs.span.tool");
    case "errors":
      return t("web.session.runs.span.error");
  }
}

function isErrorStep(step: SessionEvent): boolean {
  return step.type === "run/error" || (step.type === "tool/call" && step.ok === false);
}

function matchesStepFilter(step: SessionEvent, filter: StepFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "tools":
      return step.type === "tool/call";
    case "errors":
      return isErrorStep(step);
  }
}

interface TagTone {
  readonly bgClass: string;
  readonly bgStyle?: () => string;
  readonly text: string;
}

/** Semantic pill colors for trajectory step tags: guaranteed contrast in both light and dark modes. */
function tagToneOf(step: SessionEvent): TagTone {
  switch (step.type) {
    case "user/message":
      return { bgClass: "bg-warn-soft", text: "text-warn-ink" };
    case "memory/recalled":
    case "assistant/message":
      return { bgClass: "bg-ok-soft", text: "text-ok-ink" };
    case "assistant/thinking":
      return { bgClass: "bg-hover", text: "text-muted" };
    case "llm/retry":
    case "permission/request":
    case "interaction/request":
      return { bgClass: "bg-warn-soft", text: "text-warn-ink" };
    case "permission/resolved":
    case "interaction/resolved":
      return { bgClass: "bg-ok-soft", text: "text-ok-ink" };
    case "llm/usage":
      return { bgClass: "bg-hover", text: "text-faint" };
    case "run/error":
      return { bgClass: "bg-bad-soft", text: "text-berry" };
    case "tool/call":
      if (step.ok === false) return { bgClass: "bg-bad-soft", text: "text-berry" };
      if (step.ok === undefined) return { bgClass: "", bgStyle: () => mix("water", 0.14), text: "text-water" };
      switch (step.action ?? "other") {
        case "read_file":
        case "search":
        case "web":
          return { bgClass: "", bgStyle: () => mix("water", 0.14), text: "text-water" };
        case "edit_file":
          return { bgClass: "bg-ok-soft", text: "text-ok-ink" };
        case "wait":
          return { bgClass: "bg-warn-soft", text: "text-warn-ink" };
        case "run_command":
        case "mcp":
        case "other":
          return { bgClass: "bg-hover", text: "text-ink" };
      }
      break;
    case "run/start":
    case "run/end":
    case "tool/result":
      return { bgClass: "bg-hover", text: "text-muted" };
  }
}

function stepTextOf(step: SessionEvent): string {
  if (step.text) return localizeRuntimeError(step.text).text;
  if (step.type === "llm/usage" && step.tokens) {
    return t("web.session.trajectory.tokens", {
      input: tokensText(Math.round(step.tokens.input + step.tokens.cacheRead)),
      output: tokensText(Math.round(step.tokens.output)),
    });
  }
  return "";
}

function compactTokenBadge(step: SessionEvent): string | undefined {
  if (!step.tokens) return undefined;
  const totalIn = Math.round(step.tokens.input + step.tokens.cacheRead);
  const totalOut = Math.round(step.tokens.output);
  if (totalIn + totalOut <= 0) return undefined;
  return `${tokensText(totalIn)}/${tokensText(totalOut)}`;
}

const haystack = (step: SessionEvent, tag: string) => [tag, stepTextOf(step), step.tool ?? "", step.input ?? "", step.output ?? ""].join("\n").toLowerCase();

function summaryText(s: TrajectorySummary) {
  const hit = cacheHit(s);
  return [
    t("web.session.trajectory.runs", { n: s.runs }),
    t("web.session.trajectory.steps", { n: s.steps }),
    t("web.session.trajectory.modelTime", { took: secondsText(s.modelMs) }),
    t("web.session.trajectory.toolTime", { took: secondsText(s.toolMs) }),
    ...(hit !== undefined
      ? [
          t("web.session.trajectory.cacheHit", { pct: Math.round(hit * 100) }),
          t("web.session.trajectory.tokens", { input: tokensText(s.input + s.cacheRead), output: tokensText(s.output) }),
        ]
      : []),
  ].join(" · ");
}

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
  const steps = createSessionEvents(
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
        when={steps().length > 0}
        else={
          <View class="gap-2">
            {head()}
            <Quiet>{props.empty ?? t("web.session.trajectory.quiet")}</Quiet>
          </View>
        }
      >
        <Trajectory steps={steps()} now={now()} asked={props.asked} working={props.working === true} onMarkWrong={props.onMarkWrong} head={head()} />
      </If>
    </View>
  );
}

interface RowSpec {
  readonly step: SessionEvent;
  readonly tag: string;
  readonly when: string;
  readonly durationMs: number | undefined;
  readonly markable: boolean;
}

interface RunGroup {
  readonly key: string;
  readonly label: string;
  readonly when: string;
  readonly took: string;
  readonly stepsCount: number;
  readonly toolsCount: number;
  readonly tokens: string | undefined;
  readonly live: boolean;
  readonly hasError: boolean;
  readonly rows: readonly RowSpec[];
}

export function Trajectory(props: {
  steps: SessionEvent[];
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

  const shown = createMemo(() => shownEvents(props.steps));
  const errorCount = createMemo(() => shown().filter(isErrorStep).length);
  const hasActiveFilter = createMemo(() => query().trim().length > 0 || stepFilter() !== "all");
  const clearFilters = () => {
    query.set("");
    stepFilter.set("all");
  };
  const end = createMemo(() => {
    const last = props.steps.at(-1)?.time ?? props.now;
    return props.working === true && props.now > last ? props.now : last;
  });
  const bySeq = createMemo(() => new Map(shown().map((s) => [s.seq, s])));
  const durations = createMemo(() => stepDurationsOf(props.steps, end()));
  const summary = createMemo(() => summaryText(summaryOf(props.steps, end())));

  const groups = createMemo((): readonly RunGroup[] => {
    const firstAsked = shown().find((s) => s.type === "user/message" && s.under === undefined)?.seq;
    const filter = stepFilter();
    const q = query().trim().toLowerCase();
    const views = runsOf(shown());
    const durationMap = durations();
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
        rows.push({
          step,
          tag,
          when: ago(step.time, props.now),
          durationMs: durationMap.get(step.seq),
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
        end={end()}
        selectedSeq={marked()}
        colorOf={(seq) => {
          const s = bySeq().get(seq);
          return s ? tone(spanTone(s)) : tone("bark-400");
        }}
        summaryOf={(seq) => {
          const s = bySeq().get(seq);
          if (!s) return "";
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

function Row(props: { spec: RowSpec; open: boolean; marked: boolean; refTo: (el: ViewRef) => void; onToggle: () => void }) {
  const step = () => props.spec.step;
  const tagTone = createMemo(() => tagToneOf(step()));
  const tool = () => step().type === "tool/call";
  const running = () => tool() && step().ok === undefined;
  const failed = () => (tool() && step().ok === false) || step().type === "run/error";
  const sub = () => step().under !== undefined;
  const bodyText = createMemo(() => stepTextOf(step()));
  const summaryLine = createMemo(() => collapsedStepSummary(step(), bodyText()));
  const durationLabel = () => {
    const ms = props.spec.durationMs;
    return ms !== undefined && ms >= 100 ? secondsText(ms) : undefined;
  };
  const tokenLabel = () => (step().type === "llm/usage" ? compactTokenBadge(step()) : undefined);
  return (
    <View ref={(el) => props.refTo(el)} testID="step">
      <View
        role="button"
        testID={`step-toggle-${String(step().seq)}`}
        accessibilityLabel={`${props.spec.tag} ${summaryLine()}`}
        accessibilityState={{ expanded: props.open }}
        onPress={() => props.onToggle()}
        class={`group w-full flex-row items-center gap-2 px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-focus ${
          props.marked ? "" : props.open ? "bg-selected" : "hover:bg-hover"
        }`}
        style={props.marked ? { backgroundColor: mix("wheat", 0.25) } : undefined}
      >
        <View
          class={`h-3.5 w-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
          style={{ transform: [{ rotate: props.open ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone={props.open ? "ink" : "muted"} />
        </View>
        <View
          class={`shrink-0 rounded-sm px-1.5 py-px ${sub() ? "ml-2 w-14 border-l-2" : "w-16"} ${tagTone().bgClass}`}
          style={(() => {
            const bg = tagTone().bgStyle;
            const border = sub() ? { borderColor: mix("leaf", 0.65) } : undefined;
            return bg || border ? { ...(bg ? { backgroundColor: bg() } : {}), ...border } : undefined;
          })()}
        >
          <Text class={`truncate text-center text-2xs font-medium ${tagTone().text}`}>{props.spec.tag}</Text>
        </View>
        <View class="min-w-0 flex-1">
          <If
            when={tool()}
            else={
              <Text class={`truncate text-sm ${failed() ? "text-berry" : step().type === "llm/usage" ? "text-muted tabular-nums" : "text-ink"}`}>
                {summaryLine()}
              </Text>
            }
          >
            <ToolLine step={step()} failed={failed()} />
          </If>
        </View>
        <View class="shrink-0 flex-row items-center gap-1.5">
          <Text class={`text-2xs text-faint ${props.open ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
            {props.open ? t("web.session.trajectory.hideDetail") : t("web.session.trajectory.inspect")}
          </Text>
          <If when={durationLabel()}>{(dur) => <Text class="font-mono text-2xs text-faint tabular-nums">{dur()}</Text>}</If>
          <If when={tokenLabel()}>{(tok) => <Text class="font-mono text-2xs text-faint tabular-nums">{tok()}</Text>}</If>
          <If when={failed()}>
            <Icon name="cross" size={12} />
          </If>
          <If when={!failed() && running()}>
            <Dot tone="water" size={6} ring={false} />
          </If>
          <If when={!failed() && tool() && step().ok === true}>
            <Icon name="check" size={12} />
          </If>
          <If when={!failed() && step().type === "llm/retry"}>
            <Icon name="warn" size={12} />
          </If>
        </View>
        <Text class="w-12 shrink-0 text-right text-2xs text-faint tabular-nums">{props.spec.when}</Text>
      </View>
      <If when={props.open}>
        <StepDrawer step={step()} tag={props.spec.tag} body={bodyText()} durationMs={props.spec.durationMs} />
      </If>
    </View>
  );
}

/** Structured inline inspection drawer opened underneath any trajectory step row. */
function StepDrawer(props: { step: SessionEvent; tag: string; body: string; durationMs: number | undefined }) {
  return (
    <View testID={`step-drawer-${String(props.step.seq)}`} class="border-t border-line py-2.5 pr-3.5 pl-8" style={{ backgroundColor: mix("side", 0.7) }}>
      <If
        when={props.step.type === "tool/call"}
        else={
          <If when={props.step.type === "run/error"} else={<BodyDetail step={props.step} tag={props.tag} body={props.body} durationMs={props.durationMs} />}>
            <ErrorDetail step={props.step} />
          </If>
        }
      >
        <ToolDetail step={props.step} durationMs={props.durationMs} />
      </If>
    </View>
  );
}

/** `what {args} → result`, the args and result in the code font. */
function ToolLine(props: { step: SessionEvent; failed: boolean }) {
  const args = () => oneLine(props.step.input ?? "").trim();
  const out = () => oneLine(props.step.output ?? "").trim();
  return (
    <Text class={`truncate text-sm ${props.failed ? "text-berry" : "text-ink"}`}>
      {farmToolText(props.step.text) ?? props.step.text}
      <If when={args()}>
        <Text class="font-mono text-xs text-muted">{` ${args()}`}</Text>
      </If>
      <Text class="text-faint">{" → "}</Text>
      <If when={props.step.ok !== undefined} else={<Text class="text-xs text-water">{t("web.session.trajectory.pending")}</Text>}>
        <If when={out()} else={<Text class="text-xs text-faint">{t("web.session.trajectory.noOutput")}</Text>}>
          <Text class={`font-mono text-xs ${props.step.ok === false ? "text-berry" : "text-muted"}`}>{out()}</Text>
        </If>
      </If>
    </Text>
  );
}

function CopyStepButton(props: { testID: string; copied: boolean; label?: string | undefined; onCopy: () => void }) {
  const text = () => (props.copied ? t("web.base.rich.copied") : (props.label ?? t("web.base.rich.copy")));
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={text()}
      tooltip={<Bubble text={text()} />}
      onPress={props.onCopy}
      class="flex-row items-center gap-1 rounded-sm px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
    >
      <Icon name={props.copied ? "check" : "copy"} size={12} tone={props.copied ? "leaf" : "muted"} />
      <Text class={`text-2xs ${props.copied ? "font-medium text-ok-ink" : "text-muted"}`}>{text()}</Text>
    </View>
  );
}

function ToolDetail(props: { step: SessionEvent; durationMs: number | undefined }) {
  const copiedSlot = signal<"input" | "output" | undefined>(undefined);
  const resetCopy = useTimeout();
  createEffect(
    () => props.step.seq,
    () => copiedSlot.set(undefined),
    { defer: true },
  );
  const copyPayload = (slot: "input" | "output", value: string) => {
    void Clipboard.writeText(value).then(
      () => {
        copiedSlot.set(slot);
        resetCopy(() => copiedSlot.set(undefined), 1500);
        toast(t("web.base.rich.copied"));
      },
      () => undefined,
    );
  };
  const input = () => readableInput(props.step);
  const running = () => props.step.ok === undefined;
  const failed = () => props.step.ok === false;
  const stateLabel = () =>
    running() ? t("web.session.trajectory.running") : props.step.ok === true ? t("web.session.trajectory.ok") : t("web.session.trajectory.failed");
  const badgeClass = () => (running() ? "" : failed() ? "bg-bad-soft" : "bg-ok-soft");
  const badgeText = () => (running() ? "text-water" : failed() ? "text-berry" : "text-ok-ink");
  const durationLabel = () => (props.durationMs !== undefined ? secondsText(props.durationMs) : undefined);
  return (
    <View class="gap-2">
      <View class="flex-row items-center gap-2">
        <If when={props.step.tool}>
          <Text class="font-mono text-xs font-medium text-ink">{t("web.session.trajectory.tool", { name: props.step.tool ?? "" })}</Text>
        </If>
        <View
          testID="tool-status-badge"
          class={`rounded-sm px-1.5 py-px ${badgeClass()}`}
          style={running() ? { backgroundColor: mix("water", 0.14) } : undefined}
        >
          <Text class={`text-2xs font-medium ${badgeText()}`}>{stateLabel()}</Text>
        </View>
        <If when={durationLabel()}>
          {(dur) => (
            <Text testID="tool-duration" class="font-mono text-2xs text-muted tabular-nums">
              {dur()}
            </Text>
          )}
        </If>
      </View>
      <If when={input()}>
        {(text) => (
          <View class="gap-1">
            <View class="flex-row items-center justify-between gap-2">
              <Text class="text-2xs font-medium text-muted">{t("web.session.trajectory.input")}</Text>
              <CopyStepButton testID="tool-copy-input" copied={copiedSlot() === "input"} onCopy={() => copyPayload("input", text())} />
            </View>
            <Scroll class="max-h-40 rounded-md border border-line bg-code-bg px-2.5 py-2">
              <Text class="select-text font-mono text-xs text-code-ink">{text()}</Text>
            </Scroll>
          </View>
        )}
      </If>
      <View class="gap-1">
        <View class="flex-row items-center justify-between gap-2">
          <Text class="text-2xs font-medium text-muted">{t("web.session.trajectory.output")}</Text>
          <If when={props.step.output}>
            {(out) => <CopyStepButton testID="tool-copy-output" copied={copiedSlot() === "output"} onCopy={() => copyPayload("output", out())} />}
          </If>
        </View>
        <If
          when={props.step.output}
          else={<Text class="text-xs text-faint">{running() ? t("web.session.trajectory.pending") : t("web.session.trajectory.noOutput")}</Text>}
        >
          <Scroll
            class={`max-h-56 rounded-md border px-2.5 py-2 ${failed() ? "bg-bad-soft" : "border-line bg-page"}`}
            style={failed() ? { borderColor: mix("berry", 0.3) } : undefined}
          >
            <Text class={`select-text font-mono text-xs ${failed() ? "text-berry" : "text-ink"}`}>{props.step.output ?? ""}</Text>
          </Scroll>
        </If>
      </View>
    </View>
  );
}

function ErrorDetail(props: { step: SessionEvent }) {
  const copied = signal(false);
  const resetCopy = useTimeout();
  createEffect(
    () => props.step.seq,
    () => copied.set(false),
    { defer: true },
  );
  const localized = createMemo(() => localizeRuntimeError(props.step.text));
  const copyRaw = () => {
    void Clipboard.writeText(props.step.text).then(
      () => {
        copied.set(true);
        resetCopy(() => copied.set(false), 1500);
        toast(t("web.base.rich.copied"));
      },
      () => undefined,
    );
  };
  return (
    <View testID="error-callout" class="gap-2 rounded-md border bg-bad-soft px-3 py-2.5" style={{ borderColor: mix("berry", 0.3) }}>
      <View class="flex-row items-start gap-2">
        <View class="mt-0.5 shrink-0">
          <Icon name="cross" size={12} />
        </View>
        <Text class="min-w-0 flex-1 select-text text-sm text-berry">{localized().text}</Text>
      </View>
      <View class="flex-row items-center justify-end gap-2">
        <If when={localized().settingsHref}>
          {(href) => (
            <ButtonLink size="compact" href={href()} icon="settings" testID="error-open-settings">
              {t("web.session.trajectory.openSettings")}
            </ButtonLink>
          )}
        </If>
        <CopyStepButton testID="error-copy-raw" copied={copied()} label={t("web.session.trajectory.copyRawError")} onCopy={copyRaw} />
      </View>
    </View>
  );
}

function BodyDetail(props: { step: SessionEvent; tag: string; body: string; durationMs: number | undefined }) {
  const copied = signal(false);
  const resetCopy = useTimeout();
  createEffect(
    () => props.step.seq,
    () => copied.set(false),
    { defer: true },
  );
  const copyBody = () => {
    if (!props.body) return;
    void Clipboard.writeText(props.body).then(
      () => {
        copied.set(true);
        resetCopy(() => copied.set(false), 1500);
        toast(t("web.base.rich.copied"));
      },
      () => undefined,
    );
  };
  const durationLabel = () => (props.durationMs !== undefined && props.durationMs >= 100 ? secondsText(props.durationMs) : undefined);
  return (
    <View class="gap-1.5">
      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-row items-center gap-2">
          <Text class="text-2xs font-medium text-muted">{props.tag}</Text>
          <If when={durationLabel()}>{(dur) => <Text class="font-mono text-2xs text-faint tabular-nums">{dur()}</Text>}</If>
        </View>
        <If when={props.body.length > 0}>
          <CopyStepButton testID="step-copy-body" copied={copied()} onCopy={copyBody} />
        </If>
      </View>
      <View class="rounded-md border border-line bg-page px-3 py-2">
        <If
          when={props.step.type === "assistant/message"}
          else={
            <Text
              class={`select-text ${
                props.step.type === "llm/usage"
                  ? "font-mono text-xs text-muted tabular-nums"
                  : props.step.type === "assistant/thinking"
                    ? "text-sm text-muted"
                    : "text-sm text-ink"
              }`}
            >
              {props.body}
            </Text>
          }
        >
          <Markdown size="sm" text={props.body} />
        </If>
      </View>
    </View>
  );
}

/** Runs side by side by how long each took; the idle time between them is a fixed gap. */
function WaterfallView(props: {
  steps: SessionEvent[];
  end: number;
  selectedSeq?: number | undefined;
  colorOf: (seq: number) => string;
  summaryOf: (seq: number) => string;
  onPick: (seq: number) => void;
}) {
  const width = signal(0);
  const lane = 12;
  const gap = 3;
  const between = 4;
  const bars = createMemo(() => {
    colorScheme();
    const fall = waterfallOf(props.steps, props.end);
    const runs = fall.runs;
    if (width() <= 0 || runs.length === 0) return [];
    const room = Math.max(0, width() - between * (runs.length - 1));
    const took = runs.map(([a, b]) => b - a);
    const widths = waterfallWidths(took, room);
    const lefts: number[] = [];
    let x = 0;
    for (const w of widths) {
      lefts.push(x);
      x += w + between;
    }
    const at = (r: number, t: number) => {
      const left = lefts[r] ?? 0;
      const runTook = took[r] ?? 0;
      const runStart = runs[r]?.[0] ?? 0;
      const runWidth = widths[r] ?? 0;
      return left + (runTook > 0 ? ((t - runStart) / runTook) * runWidth : 0);
    };
    const minTickWidth = 6;
    let r = 0;
    return fall.spans.map((span) => {
      while (r + 1 < runs.length && span.start >= (runs[r + 1]?.[0] ?? 0)) r++;
      while (r > 0 && span.start < (runs[r]?.[0] ?? 0)) r--;
      const rawLeft = at(r, span.start);
      const barWidth = Math.max(minTickWidth, at(r, span.end) - rawLeft - 1);
      const left = Math.min(rawLeft, Math.max(0, width() - barWidth));
      const preview = props.summaryOf(span.seq);
      const head = `${laneNames[span.lane]} · ${secondsText(span.end - span.start)}`;
      return {
        seq: span.seq,
        left,
        width: barWidth,
        top: lanes.indexOf(span.lane) * (lane + gap),
        label: preview ? `${head}\n${preview}` : head,
        color: span.lane === "asked" ? tone("wheat") : span.lane === "model" ? tone("leaf") : props.colorOf(span.seq),
      };
    });
  });
  return (
    <View testID="waterfall" class="flex-row items-center rounded-lg border border-line bg-side px-3 py-2">
      <View class="w-12 shrink-0 justify-between" style={{ height: lane * 3 + gap * 2 }}>
        <Each of={lanes} key={(l) => l}>
          {(l) => (
            <Text class="text-2xs font-medium text-muted" style={{ lineHeight: lane }}>
              {laneNames[l()]}
            </Text>
          )}
        </Each>
      </View>
      <View onLayout={(e) => width.set(e.bounds.size.width)} class="min-w-0 flex-1 overflow-hidden" style={{ height: lane * 3 + gap * 2 }}>
        <Each of={[0, 1, 2]} key={(i) => i}>
          {(i) => <View class="absolute inset-x-0 h-3 rounded-xs bg-hover" style={{ top: i() * (lane + gap) }} />}
        </Each>
        <Each of={bars()} key="index">
          {(b) => {
            const active = () => props.selectedSeq === b().seq;
            return (
              <View
                role="button"
                testID={`waterfall-bar-${String(b().seq)}`}
                accessibilityLabel={b().label}
                tooltip={<Bubble text={b().label} />}
                onPress={() => props.onPick(b().seq)}
                class="absolute h-3 min-w-1.5 rounded-full focus-visible:outline-2 focus-visible:outline-focus"
                style={{ left: b().left, width: b().width, top: b().top, backgroundColor: active() ? tone("ink") : b().color }}
                hoverStyle={{ backgroundColor: tone("ink") }}
              />
            );
          }}
        </Each>
      </View>
    </View>
  );
}

/** Mark round wrong floats over a message it heard. */
function Markable(props: { step: number; send: MarkWrong; file?: string | undefined; onMarked: (file: string) => void; children: JSX.Element }) {
  const writing = signal(false);
  const over = signal(false);
  const act = createAct();
  const busy = act.busy;
  const want = signal("");
  const canSubmit = createMemo(() => !busy() && Boolean(want().trim()));
  const submit = async () => {
    const w = want().trim();
    if (!w || busy()) return;
    const step = props.step;
    const send = props.send;
    const got = await act.run(() => send(step, w));
    if (!got) return;
    writing.set(false);
    props.onMarked(got.file);
  };
  return (
    <View testID="round" onMouseEnter={() => over.set(true)} onMouseLeave={() => over.set(false)}>
      {props.children}
      <If when={!props.file && !writing()}>
        <View
          role="button"
          testID="mark-wrong"
          tooltip={<Bubble text={t("web.session.trajectory.wrong")} />}
          onPress={() => writing.set(true)}
          class={`absolute top-1 right-2 flex-row items-center gap-1 rounded-md border border-line bg-page px-2 py-0.5 shadow-raise ${motionClass("transition-transform duration-120 ease-out")} focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover active:translate-y-px`}
          style={{ opacity: over() ? 1 : 0 }}
          focusStyle={{ opacity: 1 }}
        >
          <Icon name="bug" size={12} tone="berry" />
          <Text class="text-xs font-medium text-ink">{t("web.session.trajectory.wrong")}</Text>
        </View>
      </If>
      <If when={props.file}>
        <View
          testID="marked"
          tooltip={<Bubble text={props.file ?? ""} />}
          class="mx-3 my-1.5 ml-8 flex-row items-center gap-1.5 rounded-md border px-2.5 py-1.5"
          style={{ backgroundColor: mix("bad-soft", 0.85), borderColor: mix("berry", 0.25) }}
        >
          <Icon name="bug" size={12} tone="berry" />
          <Text class="text-xs font-medium text-berry">{t("web.session.trajectory.marked")}</Text>
        </View>
      </If>
      <If when={writing()}>
        <View class="mx-3 my-1.5 ml-8 flex-row items-center gap-1.5">
          <TextInput
            autoFocus
            testID="mark-want"
            accessibilityLabel={t("web.session.trajectory.want")}
            disabled={busy()}
            placeholder={t("web.session.trajectory.wantHint")}
            value={want()}
            onInput={(v) => want.set(v)}
            onSubmit={() => void submit()}
            class="flex-1"
          />
          <Button tone="primary" testID="mark-submit" disabled={!canSubmit()} onPress={() => void submit()}>
            {t("web.base.write")}
          </Button>
          <Button tone="quiet" disabled={busy()} onPress={() => writing.set(false)}>
            {t("web.base.form.never")}
          </Button>
        </View>
      </If>
    </View>
  );
}
