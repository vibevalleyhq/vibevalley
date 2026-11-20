import { Scroll, signal, Text, View, type JSX, type ViewRef } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { OrchestratorEval, Session, SessionEvent } from "@vibevalley/protocol";
import { omitUndefined, oneLine } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { createMemo } from "../../../solid";
import { Keyed, useNow } from "../../base/dom";
import { ago } from "../../base/format";
import { api, reasonOf } from "../../infra/api";
import { useCore } from "../../infra/frame";
import { defineQuery, ready, retryRead, useQuery } from "../../infra/query";
import { createAct } from "../../ui/act";
import { TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Quiet } from "../../ui/layout";
import { Markdown } from "../../ui/Markdown";
import { Bubble } from "../../ui/Tip";
import { mix, tone } from "../../ui/tone";
import { createSessionEvents } from "./events";
import {
  cacheHit,
  farmToolText,
  type Lane,
  lanes,
  readableInput,
  runsOf,
  secondsText,
  shownEvents,
  spanColor,
  summaryOf,
  tagOf,
  tokensText,
  type TrajectorySummary,
  waterfallOf,
} from "./runs";
import { SubagentProgress } from "./SubagentProgress";

/** Saves the model turn its user/message `step` began as a case of the orchestrator's evals; `want` is what it should have done. */
type MarkWrong = (step: number, want: string) => Promise<OrchestratorEval>;

const laneNames: Record<Lane, string> = {
  asked: t("web.session.trajectory.lane.asked"),
  model: t("web.session.trajectory.lane.model"),
  tool: t("web.session.trajectory.lane.tool"),
};

// Usage is not a step of the work: the page's own hover ground, with the theme's ink, in either theme.
const tagFill = (step: SessionEvent) => (step.type === "llm/usage" ? tone("hover") : step.type === "llm/retry" ? tone("cream-hover") : spanColor(step));

const luminance = (hex: string) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/iu.exec(hex);
  if (!m) return 1;
  const [r = 0, g = 0, b = 0] = m.slice(1).map((h) => parseInt(h, 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** The words on a fill: whichever ink stands out more from it (WCAG's ratio), so a mid-tone fill gets the readable one. */
function inkOn(fill: string) {
  if (!/^#[0-9a-f]{6}$/iu.test(fill)) return tone("ink");
  const lightInk = tone("paper");
  const darkInk = tone("bark-900");
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const l = luminance(fill);
  return ratio(l, luminance(lightInk)) >= ratio(l, luminance(darkInk)) ? lightInk : darkInk;
}

const haystack = (step: SessionEvent, tag: string) => [tag, step.text, step.tool ?? "", step.input ?? "", step.output ?? ""].join("\n").toLowerCase();

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
        <Trajectory steps={steps()} now={now()} asked={props.asked} onMarkWrong={props.onMarkWrong} head={head()} />
      </If>
    </View>
  );
}

interface RowSpec {
  step: SessionEvent;
  tag: string;
  gutter?: string;
  when?: string;
  markable: boolean;
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
  const show = (seq: number) => {
    query.set("");
    marked.set(seq);
    requestAnimationFrame(() => rowRefs.get(seq)?.reveal({ vertical: "nearest" }));
  };

  const rows = createMemo(() => {
    const firstAsked = shown().find((s) => s.type === "user/message" && s.under === undefined)?.seq;
    const q = query().trim().toLowerCase();
    const out: RowSpec[] = [];
    let n = 0;
    for (const view of runsOf(shown())) {
      if (view.run !== undefined) n++;
      let first = true;
      for (const step of view.asked ? [view.asked, ...view.steps] : view.steps) {
        const tag = tagOf(step, props.asked, step.seq === firstAsked);
        if (q && !haystack(step, tag).includes(q)) continue;
        const firstStep = view.asked ?? view.steps[0] ?? step;
        out.push(
          omitUndefined({
            step,
            tag,
            gutter: first ? (view.run !== undefined ? t("web.session.trajectory.run", { n }) : t("web.session.trajectory.earlier")) : undefined,
            when: first ? ago(firstStep.time, props.now) : undefined,
            markable: !!props.onMarkWrong && step.type === "user/message" && step.under === undefined,
          }),
        );
        first = false;
      }
    }
    return out;
  });

  const toggle = (n: number) => {
    const o = open();
    open.set(o.has(n) ? new Set([...o].filter((x) => x !== n)) : new Set([...o, n]));
  };

  return (
    <View testID="trajectory" class="min-h-0 flex-1">
      <View class="flex-row items-center gap-3 pb-2">
        <View class="min-w-0 flex-1">{props.head}</View>
        <TextInput
          testID="trajectory-search"
          accessibilityLabel={t("web.session.trajectory.search")}
          placeholder={t("web.session.trajectory.searchHint")}
          wide={false}
          class="w-56"
          value={query()}
          onInput={(v) => query.set(v)}
        />
      </View>
      <WaterfallView
        steps={props.steps}
        end={end()}
        colorOf={(seq) => {
          const s = bySeq().get(seq);
          return s ? spanColor(s) : tone("bark-400");
        }}
        onPick={show}
      />
      <Scroll class="mt-2 min-h-0 flex-1 border-y border-line py-1">
        <If
          when={rows().length > 0}
          else={
            <Text testID="steps-empty" class="pt-2 text-sm text-muted">
              {t("web.session.trajectory.noMatch")}
            </Text>
          }
        >
          <Each of={rows()} key={(r) => r.step.seq}>
            {(r) => {
              const seq = r().step.seq;
              const row = () => (
                <Row spec={r()} open={open().has(seq)} marked={marked() === seq} refTo={(el) => rowRefs.set(seq, el)} onToggle={() => toggle(seq)} />
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
        </If>
      </Scroll>
      <Text testID="trajectory-summary" class="pt-2 text-xs text-muted">
        {summaryText(summaryOf(props.steps, end()))}
      </Text>
    </View>
  );
}

function Row(props: { spec: RowSpec; open: boolean; marked: boolean; refTo: (el: ViewRef) => void; onToggle: () => void }) {
  const step = () => props.spec.step;
  const fill = () => tagFill(step());
  const tool = () => step().type === "tool/call";
  const failed = () => (tool() && step().ok === false) || step().type === "run/error";
  const sub = () => step().under !== undefined;
  return (
    <View
      ref={(el) => props.refTo(el)}
      testID="step"
      class={`rounded-md pr-2 ${props.marked ? "" : "hover:bg-hover"}`}
      style={[{ paddingTop: 3, paddingBottom: 3 }, props.marked ? { backgroundColor: mix("wheat", 0.35) } : {}]}
    >
      <View
        role="button"
        accessibilityLabel={`${props.spec.tag} ${oneLine(step().text).trim()}`}
        accessibilityState={{ expanded: props.open }}
        onPress={() => props.onToggle()}
        class="w-full flex-row items-start"
      >
        <Text class="w-15 shrink-0 truncate pt-0.5 pl-2 text-xs text-muted">{props.spec.gutter ?? ""}</Text>
        <View
          class={`mt-px shrink-0 rounded-sm px-1 py-px ${sub() ? "ml-2.5 w-19.5" : "w-22"}`}
          style={{ backgroundColor: sub() && fill().startsWith("#") ? `${fill()}8c` : fill() }}
        >
          <Text class="truncate text-center text-xs font-medium" style={{ color: inkOn(fill()) }}>
            {props.spec.tag}
          </Text>
        </View>
        <View class="w-2 shrink-0" />
        <If when={failed() && tool()}>
          <View class="mt-1 mr-1">
            <Icon name="cross" size={12} />
          </View>
        </If>
        <View class="min-w-0 flex-1">
          <If
            when={tool()}
            else={
              <If when={props.open} else={<Text class={`truncate text-sm ${failed() ? "text-berry" : "text-ink"}`}>{oneLine(step().text).trim()}</Text>}>
                <If when={step().type === "assistant/message"} else={<Text class={`text-sm ${failed() ? "text-berry" : "text-ink"}`}>{step().text}</Text>}>
                  <Markdown size="sm" text={step().text} />
                </If>
              </If>
            }
          >
            <ToolLine step={step()} failed={failed()} />
          </If>
        </View>
        <If when={props.spec.when}>
          <Text class="shrink-0 pt-0.5 pl-2 text-xs text-faint">{props.spec.when ?? ""}</Text>
        </If>
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
        <Text class="font-mono text-muted">{` ${args()}`}</Text>
      </If>
      {" → "}
      <If when={props.step.ok !== undefined} else={t("web.session.trajectory.pending")}>
        <If when={out()} else={t("web.session.trajectory.noOutput")}>
          <Text class={`font-mono ${props.step.ok === false ? "text-berry" : ""}`}>{out()}</Text>
        </If>
      </If>
    </Text>
  );
}

function ToolDetail(props: { step: SessionEvent }) {
  const input = () => readableInput(props.step);
  return (
    <View class="gap-1 pt-1 pb-1.5 pl-41">
      <Text class="text-xs text-muted">
        {[
          ...(props.step.tool ? [t("web.session.trajectory.tool", { name: props.step.tool })] : []),
          props.step.ok === undefined
            ? t("web.session.trajectory.running")
            : props.step.ok
              ? t("web.session.trajectory.ok")
              : t("web.session.trajectory.failed"),
        ].join(" · ")}
      </Text>
      <If when={input()}>
        <Text class="text-xs text-muted">{t("web.session.trajectory.input")}</Text>
        <Text class="select-text font-mono text-xs text-ink">{input() ?? ""}</Text>
      </If>
      <Text class="text-xs text-muted">{t("web.session.trajectory.output")}</Text>
      <If
        when={props.step.output}
        else={
          <Text class="text-xs text-muted">{props.step.ok === undefined ? t("web.session.trajectory.pending") : t("web.session.trajectory.noOutput")}</Text>
        }
      >
        <Text class="select-text font-mono text-xs text-ink">{props.step.output ?? ""}</Text>
      </If>
    </View>
  );
}

/** Runs side by side by how long each took; the idle time between them is a fixed gap. */
function WaterfallView(props: { steps: SessionEvent[]; end: number; colorOf: (seq: number) => string; onPick: (seq: number) => void }) {
  const width = signal(0);
  const lane = 12;
  const gap = 2;
  const between = 4;
  const bars = createMemo(() => {
    const fall = waterfallOf(props.steps, props.end);
    const runs = fall.runs;
    if (width() <= 0 || runs.length === 0) return [];
    const room = Math.max(0, width() - between * (runs.length - 1));
    const took = runs.map(([a, b]) => b - a);
    const total = took.reduce((n, t) => n + t, 0);
    const widths = took.map((t) => (total > 0 ? (room * t) / total : room / runs.length));
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
    <View testID="waterfall" class="h-10 flex-row">
      <View class="w-15 shrink-0 justify-between pl-2">
        <Each of={lanes}>{(l) => <Text class="text-2xs leading-3 text-muted">{laneNames[l()]}</Text>}</Each>
      </View>
      <View onLayout={(e) => width.set(e.bounds.size.width)} class="min-w-0 flex-1 overflow-hidden">
        <Each of={[0, 1, 2]}>{(i) => <View class="absolute inset-x-0 h-3 rounded-sm bg-hover" style={{ top: i() * (lane + gap) }} />}</Each>
        <Each of={bars()} key="index">
          {(b) => (
            <View
              role="button"
              accessibilityLabel={b().label}
              tooltip={<Bubble text={b().label} />}
              onPress={() => props.onPick(b().seq)}
              class="absolute h-3 rounded-sm"
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
          onPress={() => writing.set(true)}
          class="absolute top-0 right-0 flex-row items-center gap-1 rounded-md border border-line bg-page px-2 py-0.5"
          style={{ opacity: over() ? 1 : 0 }}
          focusStyle={{ opacity: 1 }}
        >
          <Icon name="bug" size={12} />
          <Text class="text-xs font-medium text-ink">{t("web.session.trajectory.wrong")}</Text>
        </View>
      </If>
      <If when={props.file}>
        <View
          testID="marked"
          tooltip={<Bubble text={props.file ?? ""} />}
          class="my-0.5 mr-2 ml-41 flex-row items-center gap-1.5 rounded-md px-2 py-1"
          style={{ backgroundColor: mix("berry", 0.12) }}
        >
          <Icon name="bug" size={12} />
          <Text class="text-xs text-ink">{t("web.session.trajectory.marked")}</Text>
        </View>
      </If>
      <If when={writing()}>
        <View class="my-1 mr-2 ml-41 flex-row items-center gap-1.5">
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
          <View
            role="button"
            testID="mark-submit"
            disabled={busy() || !want().trim()}
            onPress={() => void submit()}
            class={`h-7 shrink-0 justify-center rounded-md bg-accent px-2.5 ${busy() || !want().trim() ? "opacity-50" : ""}`}
          >
            <Text class="text-sm text-page">{t("web.base.write")}</Text>
          </View>
          <View role="button" disabled={busy()} onPress={() => writing.set(false)} class="h-7 shrink-0 justify-center rounded-md border border-line px-2.5">
            <Text class="text-sm text-ink">{t("web.base.form.never")}</Text>
          </View>
        </View>
      </If>
    </View>
  );
}

/** The helpers an agent sent, a list to pick from beside the picked one's trajectory. */
const sessionsQuery = defineQuery({
  schema: z.array(S.Session),
  key: (agent: string) => ["sessions", agent],
  fetch: (agent, context) => api.session.list({ agent }, context),
  ...retryRead,
});
export function TrajectoryList(props: { agent: string }) {
  const core = useCore();
  const heads = useQuery(() => sessionsQuery(props.agent));
  const picked = signal<string>();
  const now = useNow();
  const list = () => ready(heads, undefined);
  const open = () => {
    const all = list();
    return all?.find((h) => h.id === (picked() ?? all[0]?.id));
  };
  const box = signal(0);
  const wide = () => box() === 0 || box() >= 768;
  return (
    <If when={list()} else={<Quiet>{heads.error() ? reasonOf(heads.error()) : t("web.base.reading")}</Quiet>}>
      {(all) => (
        <If when={all().length > 0} else={<Quiet>{t("web.session.trajectory.neverSent")}</Quiet>}>
          <View onLayout={(e) => box.set(e.bounds.size.width)} class={`min-h-0 flex-1 gap-3 ${wide() ? "flex-row" : ""}`}>
            <Scroll
              accessibilityLabel={t("web.session.trajectory.sent")}
              class={`shrink-0 ${wide() ? "w-60" : ""}`}
              style={wide() ? undefined : { maxHeight: 132 }}
            >
              <Each of={all()} key={(h) => h.id}>
                {(h) => {
                  const ended = () => {
                    const phase = h().phase;
                    return phase._tag === "closed" ? phase.at : undefined;
                  };
                  const sentText = () => {
                    const left = ended();
                    return left === undefined
                      ? t("web.session.trajectory.hired", { ago: ago(h().hiredAt, now()) })
                      : t("web.session.trajectory.hiredAndLeft", { hired: ago(h().hiredAt, now()), left: ago(left, now()) });
                  };
                  return (
                    <View
                      role="button"
                      testID="sent-session"
                      accessibilityState={{ selected: h().id === open()?.id }}
                      onPress={() => picked.set(h().id)}
                      class={`mb-0.5 w-full rounded-md px-2.5 py-1.5 ${h().id === open()?.id ? "bg-selected" : "hover:bg-hover"}`}
                    >
                      <View class="flex-row flex-wrap items-center gap-2">
                        <Text class="text-sm font-medium text-ink">{h().name}</Text>
                        <If when={h().repo}>
                          <Text class="text-xs text-muted">{h().repo ?? ""}</Text>
                        </If>
                        <If when={ended() === undefined}>
                          <View class="rounded-sm bg-hat px-1.5">
                            <Text class="text-xs text-bark-900">{t("web.session.trajectory.here")}</Text>
                          </View>
                        </If>
                      </View>
                      <Text class="text-xs text-muted">{sentText()}</Text>
                      <If when={h().brief}>
                        <Text class="truncate text-xs text-ink">{oneLine(h().brief).trim()}</Text>
                      </If>
                    </View>
                  );
                }}
              </Each>
            </Scroll>
            <View class="min-h-0 min-w-0 flex-1">
              <If when={open()} else={<Quiet>{t("web.session.trajectory.pick")}</Quiet>}>
                {(o) => (
                  <Keyed key={o().id}>
                    {() => (
                      <TrajectoryLog
                        id={o().id}
                        subagents={(core()?.sessions.find((session) => session.id === o().id) ?? o()).subagents}
                        title={o().brief ? `${o().name} · ${oneLine(o().brief).trim()}` : o().name}
                        about={o().brief}
                      />
                    )}
                  </Keyed>
                )}
              </If>
            </View>
          </View>
        </If>
      )}
    </If>
  );
}
