import { colorScheme, Scroll, signal, Text, View, type JSX, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { OrchestratorEval, Session, SessionEvent } from "@vibevalley/protocol";
import { oneLine } from "@vibevalley/protocol/rules";

import { createMemo } from "../../../solid";
import { useNow } from "../../base/dom";
import { ago } from "../../base/format";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { SearchField, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Quiet } from "../../ui/layout";
import { Markdown } from "../../ui/Markdown";
import { Dot } from "../../ui/Tag";
import { Bubble } from "../../ui/Tip";
import { mix, tone } from "../../ui/tone";
import { createSessionEvents } from "./events";
import {
  cacheHit,
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
      return { bgClass: "bg-warn-soft", text: "text-warn-ink" };
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
  if (step.text) return step.text;
  if (step.type === "llm/usage" && step.tokens) {
    return t("web.session.trajectory.tokens", {
      input: tokensText(Math.round(step.tokens.input + step.tokens.cacheRead)),
      output: tokensText(Math.round(step.tokens.output)),
    });
  }
  return "";
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
  const head = () =>
    props.title ? (
      <View tooltip={props.about ? <Bubble text={props.about} /> : undefined}>
        <Text class="truncate text-sm font-semibold text-ink">{props.title}</Text>
      </View>
    ) : undefined;
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
  step: SessionEvent;
  tag: string;
  when: string;
  markable: boolean;
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
  const open = signal<ReadonlySet<number>>(new Set());
  const collapsedRuns = signal<ReadonlySet<string>>(new Set());
  const marked = signal<number>();
  // The messages marked wrong here, by their step: the case's file.
  const wrong = signal<ReadonlyMap<number, string>>(new Map());
  const rowRefs = new Map<number, ViewRef>();

  const shown = createMemo(() => shownEvents(props.steps));
  const end = () => {
    const last = props.steps.at(-1)?.time ?? props.now;
    return props.working === true && props.now > last ? props.now : last;
  };
  const bySeq = createMemo(() => new Map(shown().map((s) => [s.seq, s])));

  const groups = createMemo((): readonly RunGroup[] => {
    const firstAsked = shown().find((s) => s.type === "user/message" && s.under === undefined)?.seq;
    const q = query().trim().toLowerCase();
    const views = runsOf(shown());
    const out: RunGroup[] = [];
    let n = 0;
    views.forEach((view, idx) => {
      if (view.run !== undefined) n++;
      const allSteps = view.asked ? [view.asked, ...view.steps] : view.steps;
      const rows: RowSpec[] = [];
      for (const step of allSteps) {
        const tag = tagOf(step, props.asked, step.seq === firstAsked);
        if (q && !haystack(step, tag).includes(q)) continue;
        rows.push({
          step,
          tag,
          when: ago(step.time, props.now),
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

  const show = (seq: number) => {
    query.set("");
    const targetGroup = groups().find((g) => g.rows.some((r) => r.step.seq === seq));
    if (targetGroup && collapsedRuns().has(targetGroup.key)) {
      collapsedRuns.set(new Set([...collapsedRuns()].filter((k) => k !== targetGroup.key)));
    }
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
      <View class="flex-row items-center gap-3 pb-2">
        <View class="min-w-0 flex-1">{props.head}</View>
        <SearchField
          testid="trajectory-search"
          clearLabel={t("web.base.lightbox.close")}
          value={query()}
          onInput={(v) => query.set(v)}
          placeholder={t("web.session.trajectory.searchHint")}
          label={t("web.session.trajectory.search")}
          class="w-56"
        />
      </View>
      <WaterfallView
        steps={props.steps}
        end={end()}
        colorOf={(seq) => {
          const s = bySeq().get(seq);
          return s ? tone(spanTone(s)) : tone("bark-400");
        }}
        onPick={show}
      />
      <Scroll class="mt-2 min-h-0 flex-1 border-y border-line" contentClass="py-1.5">
        <If
          when={groups().length > 0}
          else={
            <Text testID="steps-empty" class="px-2 py-3 text-sm text-muted">
              {t("web.session.trajectory.noMatch")}
            </Text>
          }
        >
          <Each of={groups()} key={(g) => g.key}>
            {(group, groupIdx) => {
              const isRunOpen = () => query().trim().length > 0 || !collapsedRuns().has(group().key);
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
                <View class={groupIdx() > 0 ? "mt-1.5 border-t border-line pt-1.5" : ""}>
                  <View
                    role="button"
                    accessibilityState={{ expanded: isRunOpen() }}
                    accessibilityLabel={isRunOpen() ? t("web.session.log.fold") : t("web.session.log.unfold")}
                    onPress={() => toggleRun(group().key)}
                    class="mb-0.5 flex-row items-center gap-2 rounded-md px-2 py-1 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
                  >
                    <View
                      class="h-3.5 w-3.5 shrink-0 items-center justify-center transition-transform duration-120 ease-out"
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
                    <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{group().label}</Text>
                    <View class="shrink-0 flex-row items-center gap-2">
                      <Text class={`text-2xs tabular-nums ${group().live ? "font-medium text-water" : group().hasError ? "text-berry" : "text-muted"}`}>
                        {metaParts().join(" · ")}
                      </Text>
                      <If when={group().when}>
                        <Text class="text-right text-2xs text-faint tabular-nums">{group().when}</Text>
                      </If>
                    </View>
                  </View>
                  <If when={isRunOpen()}>
                    <View class="gap-0.5">
                      <Each of={group().rows} key={(r) => r.step.seq}>
                        {(r) => {
                          const seq = r().step.seq;
                          const row = () => (
                            <Row
                              spec={r()}
                              open={open().has(seq)}
                              marked={marked() === seq}
                              refTo={(el) => rowRefs.set(seq, el)}
                              onToggle={() => toggle(seq)}
                            />
                          );
                          return (
                            <If when={r().markable ? props.onMarkWrong : undefined} else={row()}>
                              {(send) => (
                                <Markable step={seq} send={send()} file={wrong().get(seq)} onMarked={(file) => wrong.set(new Map([...wrong(), [seq, file]]))}>
                                  {row()}
                                </Markable>
                              )}
                            </If>
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
      <Text testID="trajectory-summary" class="pt-2 text-xs text-muted tabular-nums">
        {summaryText(summaryOf(props.steps, end()))}
      </Text>
    </View>
  );
}

function Row(props: { spec: RowSpec; open: boolean; marked: boolean; refTo: (el: ViewRef) => void; onToggle: () => void }) {
  const step = () => props.spec.step;
  const tagTone = () => tagToneOf(step());
  const tool = () => step().type === "tool/call";
  const running = () => tool() && step().ok === undefined;
  const failed = () => (tool() && step().ok === false) || step().type === "run/error";
  const sub = () => step().under !== undefined;
  const bodyText = () => stepTextOf(step());
  return (
    <View
      ref={(el) => props.refTo(el)}
      testID="step"
      class={`rounded-md transition duration-120 ease-out ${props.marked ? "" : props.open ? "bg-hover" : "hover:bg-hover"}`}
      style={props.marked ? { backgroundColor: mix("wheat", 0.25) } : undefined}
    >
      <View
        role="button"
        accessibilityLabel={`${props.spec.tag} ${oneLine(bodyText()).trim()}`}
        accessibilityState={{ expanded: props.open }}
        onPress={() => props.onToggle()}
        class="w-full flex-row items-start gap-2 px-2 py-1"
      >
        <View
          class="mt-1 h-3.5 w-3.5 shrink-0 items-center justify-center transition-transform duration-120 ease-out"
          style={{ transform: [{ rotate: props.open ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <View
          class={`mt-px shrink-0 rounded-sm px-1.5 py-px ${sub() ? "ml-2.5 w-19.5 border-l-2" : "w-22"} ${tagTone().bgClass}`}
          style={(() => {
            const bg = tagTone().bgStyle;
            const border = sub() ? { borderColor: mix("leaf", 0.65) } : undefined;
            return bg || border ? { ...(bg ? { backgroundColor: bg() } : {}), ...border } : undefined;
          })()}
        >
          <Text class={`truncate text-center text-2xs font-medium ${tagTone().text}`}>{props.spec.tag}</Text>
        </View>
        <View class="mt-1 h-3.5 w-3.5 shrink-0 items-center justify-center">
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
        <View class="min-w-0 flex-1">
          <If
            when={tool()}
            else={
              <If
                when={props.open}
                else={
                  <Text class={`truncate text-sm ${failed() ? "text-berry" : step().type === "llm/usage" ? "text-muted tabular-nums" : "text-ink"}`}>
                    {oneLine(bodyText()).trim()}
                  </Text>
                }
              >
                <If
                  when={step().type === "assistant/message"}
                  else={
                    <Text class={`text-sm ${failed() ? "text-berry" : step().type === "llm/usage" ? "text-muted tabular-nums" : "text-ink"}`}>
                      {bodyText()}
                    </Text>
                  }
                >
                  <Markdown size="sm" text={bodyText()} />
                </If>
              </If>
            }
          >
            <ToolLine step={step()} failed={failed()} />
          </If>
        </View>
        <Text class="shrink-0 pt-0.5 pl-1 text-right text-2xs text-faint tabular-nums">{props.spec.when}</Text>
      </View>
      <If when={props.open && tool()}>
        <ToolDetail step={step()} />
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

function ToolDetail(props: { step: SessionEvent }) {
  const input = () => readableInput(props.step);
  const running = () => props.step.ok === undefined;
  const failed = () => props.step.ok === false;
  const stateLabel = () =>
    running() ? t("web.session.trajectory.running") : props.step.ok === true ? t("web.session.trajectory.ok") : t("web.session.trajectory.failed");
  const badgeClass = () => (running() ? "" : failed() ? "bg-bad-soft" : "bg-ok-soft");
  const badgeText = () => (running() ? "text-water" : failed() ? "text-berry" : "text-ok-ink");
  return (
    <View class="mt-1 mr-2 mb-1.5 ml-7.5 gap-1.5 rounded-md border border-line bg-side p-2.5">
      <View class="flex-row items-center gap-2">
        <If when={props.step.tool}>
          <Text class="font-mono text-xs text-muted">{t("web.session.trajectory.tool", { name: props.step.tool ?? "" })}</Text>
        </If>
        <View class={`rounded-sm px-1.5 py-px ${badgeClass()}`} style={running() ? { backgroundColor: mix("water", 0.14) } : undefined}>
          <Text class={`text-2xs font-medium ${badgeText()}`}>{stateLabel()}</Text>
        </View>
      </View>
      <If when={input()}>
        <Text class="text-2xs font-medium text-muted">{t("web.session.trajectory.input")}</Text>
        <Scroll class="max-h-40 rounded-md border border-line bg-code-bg px-2.5 py-2">
          <Text class="select-text font-mono text-xs text-code-ink">{input() ?? ""}</Text>
        </Scroll>
      </If>
      <Text class="text-2xs font-medium text-muted">{t("web.session.trajectory.output")}</Text>
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
  );
}

/** Runs side by side by how long each took; the idle time between them is a fixed gap. */
function WaterfallView(props: { steps: SessionEvent[]; end: number; colorOf: (seq: number) => string; onPick: (seq: number) => void }) {
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
    let r = 0;
    return fall.spans.map((span) => {
      while (r + 1 < runs.length && span.start >= (runs[r + 1]?.[0] ?? 0)) r++;
      while (r > 0 && span.start < (runs[r]?.[0] ?? 0)) r--;
      const left = at(r, span.start);
      return {
        seq: span.seq,
        left,
        width: Math.max(2, at(r, span.end) - left),
        top: lanes.indexOf(span.lane) * (lane + gap),
        label: `${laneNames[span.lane]} · ${secondsText(span.end - span.start)}`,
        color: span.lane === "asked" ? tone("wheat") : span.lane === "model" ? tone("leaf") : props.colorOf(span.seq),
      };
    });
  });
  return (
    <View testID="waterfall" class="flex-row items-center rounded-md border border-line bg-side px-2 py-2">
      <View class="w-12 shrink-0 justify-between" style={{ height: lane * 3 + gap * 2 }}>
        <Each of={lanes}>
          {(l) => (
            <Text class="text-2xs font-medium text-muted" style={{ lineHeight: lane }}>
              {laneNames[l()]}
            </Text>
          )}
        </Each>
      </View>
      <View onLayout={(e) => width.set(e.bounds.size.width)} class="min-w-0 flex-1 overflow-hidden" style={{ height: lane * 3 + gap * 2 }}>
        <Each of={[0, 1, 2]}>{(i) => <View class="absolute inset-x-0 h-3 rounded-xs bg-hover" style={{ top: i() * (lane + gap) }} />}</Each>
        <Each of={bars()} key="index">
          {(b) => (
            <View
              role="button"
              accessibilityLabel={b().label}
              tooltip={<Bubble text={b().label} />}
              onPress={() => props.onPick(b().seq)}
              class="absolute h-3 rounded-xs"
              style={{ left: b().left, width: b().width - 1, top: b().top, backgroundColor: b().color }}
              hoverStyle={{ backgroundColor: tone("ink") }}
            />
          )}
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
          class="absolute top-0.5 right-1 flex-row items-center gap-1 rounded-md border border-line bg-page px-2 py-0.5 shadow-raise transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover active:translate-y-px"
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
          class="my-1 mr-2 ml-7.5 flex-row items-center gap-1.5 rounded-md border px-2.5 py-1.5"
          style={{ backgroundColor: mix("bad-soft", 0.85), borderColor: mix("berry", 0.25) }}
        >
          <Icon name="bug" size={12} tone="berry" />
          <Text class="text-xs font-medium text-berry">{t("web.session.trajectory.marked")}</Text>
        </View>
      </If>
      <If when={writing()}>
        <View class="my-1.5 mr-2 ml-7.5 flex-row items-center gap-1.5">
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
          <Button tone="primary" testID="mark-submit" disabled={busy() || !want().trim()} onPress={() => void submit()}>
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
