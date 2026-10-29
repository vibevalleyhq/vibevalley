import { t } from "@vibevalley/i18n";
// A trajectory a row per step: the round in the gutter, what kind of step in the tag, its text cut to a line until the
// row is opened; a waterfall of the rounds over it and their totals under it. The orchestrator's lets a round be marked
// wrong, which saves it as a case of its evals.

import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, Switch, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";

import type { OrchestratorEval, SessionEvent } from "@vibevalley/protocol";
import { api, reasonOf } from "@/base/api";
import {
  cacheHit,
  farmToolText,
  type Lane,
  lanes,
  oneLine,
  readableInput,
  roundsOf,
  secondsText,
  shownEvents,
  spanColor,
  summaryOf,
  tagOf,
  tokensText,
  type TrajectorySummary,
  waterfallOf,
} from "./rounds";
import { ago } from "@/base/format";
import { toast } from "@/ui/toasts";
import { aria, autofocus, Keyed, useNow } from "@/base/util";
import { createSessionEvents } from "./data";
import { ready, useQuery } from "@/base/query";
import { TextInput } from "@/ui/Field";
import { Icon } from "@/ui/Icon";
import { Markdown } from "@/ui/Markdown";
import { Quiet } from "@/ui/layout";
import { omitUndefined } from "@vibevalley/protocol/rules";

/** Saves the round its user/message `step` began as a case of the orchestrator's evals; `want` is what it should have done. */
export type MarkWrong = (step: number, want: string) => Promise<OrchestratorEval>;

const laneNames: Record<Lane, string> = {
  asked: t("web.session.trajectory.lane.asked"),
  model: t("web.session.trajectory.lane.model"),
  tool: t("web.session.trajectory.lane.tool"),
};

// Usage is not a step of the work: the page's own hover ground, with the theme's ink, in either theme.
const tagFill = (step: SessionEvent) => (step.type === "llm/usage" ? "var(--wb-hover)" : step.type === "llm/retry" ? "#f1dcab" : spanColor(step));

const lightInk = "#fffaf0";
const darkInk = "#2f1f13";

const luminance = (hex: string) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return 1;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255) as [number, number, number];
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** The words on a fill: whichever ink stands out more from it (WCAG's ratio), so a mid-tone fill gets the readable one. */
function inkOn(fill: string) {
  if (!/^#[0-9a-f]{6}$/i.test(fill)) return "var(--wb-ink)";
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const l = luminance(fill);
  return ratio(l, luminance(lightInk)) >= ratio(l, luminance(darkInk)) ? lightInk : darkInk;
}

const haystack = (step: SessionEvent, tag: string) => [tag, step.text, step.tool ?? "", step.input ?? "", step.output ?? ""].join("\n").toLowerCase();

function summaryText(s: TrajectorySummary) {
  const hit = cacheHit(s);
  return [
    t("web.session.trajectory.rounds", { n: s.rounds }),
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
export function TrajectoryLog(props: { id: string; asked?: string; empty?: string; onMarkWrong?: MarkWrong; title?: string; about?: string }) {
  const steps = createSessionEvents(
    () => props.id,
    () => true,
  );
  const now = useNow();
  const head = () =>
    props.title ? (
      <span class="truncate text-sm font-semibold" title={props.about}>
        {props.title}
      </span>
    ) : undefined;
  return (
    <Show
      when={steps().length > 0}
      fallback={
        <div class="flex flex-col gap-2">
          {head()}
          <Quiet>{props.empty ?? t("web.session.trajectory.quiet")}</Quiet>
        </div>
      }
    >
      <Trajectory steps={steps()} now={now()} asked={props.asked} onMarkWrong={props.onMarkWrong} head={head()} />
    </Show>
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
  const [query, setQuery] = createSignal("");
  const [open, setOpen] = createSignal<ReadonlySet<number>>(new Set());
  const [marked, setMarked] = createSignal<number>();
  // The rounds marked wrong here, by their asked step: the case's file.
  const [wrong, setWrong] = createSignal<ReadonlyMap<number, string>>(new Map());
  let scroller: HTMLDivElement | undefined;
  let atBottom = true;
  const rowEls = new Map<number, HTMLElement>();

  // Stuck to the newest unless scrolled up.
  createEffect(
    () => props.steps.length,
    () => {
      if (scroller && atBottom) scroller.scrollTop = scroller.scrollHeight;
    },
  );

  const shown = createMemo(() => shownEvents(props.steps));
  const end = () => {
    const last = props.steps.at(-1)?.time ?? props.now;
    return props.working && props.now > last ? props.now : last;
  };
  const bySeq = createMemo(() => new Map(shown().map((s) => [s.seq, s])));
  const show = (seq: number) => {
    setQuery("");
    setMarked(seq);
    atBottom = false;
    requestAnimationFrame(() => rowEls.get(seq)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };

  const rows = createMemo(() => {
    const firstAsked = shown().find((s) => s.type === "user/message" && s.under === undefined)?.seq;
    const q = query().trim().toLowerCase();
    const out: RowSpec[] = [];
    let turn = 0;
    for (const round of roundsOf(shown())) {
      if (round.asked) turn++;
      let first = true;
      for (const step of round.asked ? [round.asked, ...round.steps] : round.steps) {
        const tag = tagOf(step, props.asked, step.seq === firstAsked);
        if (q && !haystack(step, tag).includes(q)) continue;
        out.push(
          omitUndefined({
            step,
            tag,
            gutter: first ? (round.asked ? t("web.session.trajectory.round", { n: turn }) : t("web.session.trajectory.earlier")) : undefined,
            when: first ? ago((round.asked ?? round.steps[0]!).time, props.now) : undefined,
            markable: !!props.onMarkWrong && step.type === "user/message" && step.under === undefined,
          }),
        );
        first = false;
      }
    }
    return out;
  });

  const toggle = (n: number) => setOpen((o) => (o.has(n) ? new Set([...o].filter((x) => x !== n)) : new Set([...o, n])));

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex items-center gap-3 pb-2">
        <div class="min-w-0 flex-1">{props.head}</div>
        <TextInput
          data-testid="trajectory-search"
          aria-label={t("web.session.trajectory.search")}
          placeholder={t("web.session.trajectory.searchHint")}
          class="w-36 sm:w-56"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      <WaterfallView steps={props.steps} end={end()} colorOf={(seq) => (bySeq().get(seq) ? spanColor(bySeq().get(seq)!) : "#9b7550")} onPick={show} />
      <div
        ref={(el) => (scroller = el)}
        class="mt-2 min-h-0 flex-1 overflow-y-auto border-y border-line py-1"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        <Show
          when={rows().length > 0}
          fallback={
            <p data-testid="steps-empty" class="pt-2 text-sm text-muted">
              {t("web.session.trajectory.noMatch")}
            </p>
          }
        >
          <For each={rows()} keyed={(r) => r.step.seq}>
            {(r) => {
              // The key, the same for the row's life; a ref reading the item's accessor while the row is made suspends it.
              const seq = untrack(() => r().step.seq);
              const row = () => (
                <Row
                  spec={r()}
                  open={open().has(r().step.seq)}
                  marked={marked() === r().step.seq}
                  refTo={(el) => rowEls.set(seq, el)}
                  onToggle={() => toggle(r().step.seq)}
                />
              );
              return (
                <Show when={r().markable && props.onMarkWrong} fallback={row()}>
                  {(send) => (
                    <Markable
                      step={r().step.seq}
                      send={send()}
                      file={wrong().get(r().step.seq)}
                      onMarked={(file) => setWrong(new Map([...wrong(), [r().step.seq, file]]))}
                    >
                      {row()}
                    </Markable>
                  )}
                </Show>
              );
            }}
          </For>
        </Show>
      </div>
      <p class="pt-2 text-xs text-muted">{summaryText(summaryOf(props.steps, end()))}</p>
    </div>
  );
}

const gutterW = "w-15";
const tagW = "w-22";

function Row(props: { spec: RowSpec; open: boolean; marked: boolean; refTo: (el: HTMLElement) => void; onToggle: () => void }) {
  const step = () => props.spec.step;
  const fill = () => tagFill(step());
  const tool = () => step().type === "tool/call";
  const failed = () => (tool() && step().ok === false) || step().type === "run/error";
  const sub = () => step().under !== undefined;
  return (
    <div
      ref={(el) => props.refTo(el)}
      data-testid="step"
      data-type={step().type}
      class={["rounded-md py-[3px] pr-2", props.marked ? "bg-wheat/35" : "hover:bg-hover"]}
    >
      <button
        type="button"
        aria-label={`${props.spec.tag} ${oneLine(step().text)}`}
        aria-expanded={aria(props.open)}
        onClick={() => props.onToggle()}
        class="flex w-full cursor-pointer items-start text-left"
      >
        <span class={[gutterW, "shrink-0 truncate pt-0.5 pl-2 text-xs text-muted"]}>{props.spec.gutter}</span>
        <span
          class={["mt-px shrink-0 truncate rounded px-1 py-px text-center text-xs font-medium", sub() ? "ml-2.5 w-[78px]" : tagW]}
          style={{ background: sub() && fill().startsWith("#") ? `${fill()}8c` : fill(), color: inkOn(fill()) }}
        >
          {props.spec.tag}
        </span>
        <span class="w-2 shrink-0" />
        <Show when={failed() && tool()}>
          <Icon name="cross" size={12} class="mt-1 mr-1" />
        </Show>
        <span class={["min-w-0 flex-1 text-sm", { "text-berry": failed() }]}>
          <Switch fallback={<span class="block truncate">{oneLine(step().text)}</span>}>
            <Match when={tool()}>
              <ToolLine step={step()} />
            </Match>
            <Match when={props.open && step().type === "assistant/message"}>
              <Markdown text={step().text} />
            </Match>
            <Match when={props.open}>
              <span class="whitespace-pre-wrap">{step().text}</span>
            </Match>
          </Switch>
        </span>
        <Show when={props.spec.when}>
          <span class="shrink-0 pt-0.5 pl-2 text-xs text-faint">{props.spec.when}</span>
        </Show>
      </button>
      <Show when={props.open && tool()}>
        <ToolDetail step={step()} />
      </Show>
    </div>
  );
}

/** `what {args} → result`, the args and result in the code font. */
function ToolLine(props: { step: SessionEvent }) {
  const args = () => oneLine(props.step.input ?? "");
  const out = () => oneLine(props.step.output ?? "");
  return (
    <span class="block truncate">
      {farmToolText(props.step.text) ?? props.step.text}
      <Show when={args()}>
        <span class="font-mono text-muted"> {args()}</span>
      </Show>
      {" → "}
      <Switch fallback={<span class={["font-mono", { "text-berry": props.step.ok === false }]}>{out()}</span>}>
        <Match when={props.step.ok === undefined}>{t("web.session.trajectory.pending")}</Match>
        <Match when={!out()}>{t("web.session.trajectory.noOutput")}</Match>
      </Switch>
    </span>
  );
}

function ToolDetail(props: { step: SessionEvent }) {
  const input = () => readableInput(props.step);
  return (
    <div class="flex flex-col gap-1 pt-1 pb-1.5 pl-[164px] text-xs">
      <span class="text-muted">
        {[
          ...(props.step.tool ? [t("web.session.trajectory.tool", { name: props.step.tool })] : []),
          props.step.ok === undefined
            ? t("web.session.trajectory.running")
            : props.step.ok
              ? t("web.session.trajectory.ok")
              : t("web.session.trajectory.failed"),
        ].join(" · ")}
      </span>
      <Show when={input()}>
        <span class="text-muted">{t("web.session.trajectory.input")}</span>
        <pre class="font-mono whitespace-pre-wrap select-text">{input()}</pre>
      </Show>
      <span class="text-muted">{t("web.session.trajectory.output")}</span>
      <Show
        when={props.step.output}
        fallback={<span class="text-muted">{props.step.ok === undefined ? t("web.session.trajectory.pending") : t("web.session.trajectory.noOutput")}</span>}
      >
        <pre class="font-mono whitespace-pre-wrap select-text">{props.step.output}</pre>
      </Show>
    </div>
  );
}

/** Rounds side by side by how long each took; the idle time between them is a fixed gap. */
function WaterfallView(props: { steps: SessionEvent[]; end: number; colorOf: (seq: number) => string; onPick: (seq: number) => void }) {
  let box!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  onSettled(() => {
    const ro = new ResizeObserver(() => setWidth(box.clientWidth));
    ro.observe(box);
    setWidth(box.clientWidth);
    return () => ro.disconnect();
  });
  const lane = 12;
  const gap = 2;
  const between = 4;
  const bars = createMemo(() => {
    const fall = waterfallOf(props.steps, props.end);
    const rounds = fall.rounds;
    if (width() <= 0 || rounds.length === 0) return [];
    const room = Math.max(0, width() - between * (rounds.length - 1));
    const took = rounds.map(([a, b]) => b - a);
    const total = took.reduce((n, t) => n + t, 0);
    const widths = took.map((t) => (total > 0 ? (room * t) / total : room / rounds.length));
    const lefts: number[] = [];
    let x = 0;
    for (const w of widths) {
      lefts.push(x);
      x += w + between;
    }
    const at = (r: number, t: number) => lefts[r]! + (took[r]! > 0 ? ((t - rounds[r]![0]) / took[r]!) * widths[r]! : 0);
    let r = 0;
    return fall.spans.map((span) => {
      while (r + 1 < rounds.length && span.start >= rounds[r + 1]![0]) r++;
      while (r > 0 && span.start < rounds[r]![0]) r--;
      const left = at(r, span.start);
      return {
        seq: span.seq,
        left,
        width: Math.max(2, at(r, span.end) - left),
        top: lanes.indexOf(span.lane) * (lane + gap),
        label: `${laneNames[span.lane]} · ${secondsText(span.end - span.start)}`,
        color: span.lane === "asked" ? "#e5a93c" : span.lane === "model" ? "#74a046" : props.colorOf(span.seq),
      };
    });
  });
  return (
    <div class="flex" style={{ height: `${lane * 3 + gap * 2}px` }}>
      <div class={[gutterW, "flex shrink-0 flex-col justify-between pl-2"]}>
        <For each={lanes}>{(l) => <span class="text-2xs leading-none text-muted">{laneNames[l]}</span>}</For>
      </div>
      <div ref={(el) => (box = el)} class="relative min-w-0 flex-1 overflow-hidden">
        <For each={[0, 1, 2]}>
          {(i) => <div class="absolute inset-x-0 rounded-sm bg-hover" style={{ top: `${i * (lane + gap)}px`, height: `${lane}px` }} />}
        </For>
        <For each={bars()} keyed={false}>
          {(b) => (
            <button
              type="button"
              title={b().label}
              aria-label={b().label}
              onClick={() => props.onPick(b().seq)}
              class="absolute cursor-pointer rounded-sm hover:!bg-ink"
              style={{ left: `${b().left}px`, width: `${b().width - 1}px`, top: `${b().top}px`, height: `${lane}px`, background: b().color }}
            />
          )}
        </For>
      </div>
    </div>
  );
}

/** 这一轮做错了 floats over what began the round. */
function Markable(props: { step: number; send: MarkWrong; file?: string | undefined; onMarked: (file: string) => void; children: JSX.Element }) {
  const [writing, setWriting] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [want, setWant] = createSignal("");
  const submit = async () => {
    const w = want().trim();
    if (!w || busy()) return;
    const step = props.step;
    const send = props.send;
    setBusy(true);
    try {
      const got = await send(step, w);
      setWriting(false);
      props.onMarked(got.file);
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="round" data-key={props.step} data-marked={props.file ? "" : undefined} class="group relative">
      {props.children}
      <Show when={!props.file && !writing()}>
        <button
          type="button"
          data-testid="mark-wrong"
          onClick={() => setWriting(true)}
          class="absolute top-0 right-0 hidden cursor-pointer items-center gap-1 rounded-md border border-line bg-page px-2 py-0.5 text-xs font-medium group-focus-within:flex group-hover:flex hover:underline"
        >
          <Icon name="bug" size={12} />
          {t("web.session.trajectory.wrong")}
        </button>
      </Show>
      <Show when={props.file}>
        <div title={props.file} class="my-0.5 mr-2 ml-[164px] flex items-center gap-1.5 rounded-md bg-berry/12 px-2 py-1 text-xs">
          <Icon name="bug" size={12} />
          {t("web.session.trajectory.marked")}
        </div>
      </Show>
      <Show when={writing()}>
        <form
          class="my-1 mr-2 ml-[164px] flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <TextInput
            ref={autofocus()}
            data-testid="mark-want"
            aria-label={t("web.session.trajectory.want")}
            disabled={busy()}
            placeholder={t("web.session.trajectory.wantHint")}
            value={want()}
            onInput={(e) => setWant(e.currentTarget.value)}
          />
          <button
            type="submit"
            data-testid="mark-submit"
            disabled={busy() || !want().trim()}
            class="h-7 shrink-0 cursor-pointer rounded-md bg-accent px-2.5 text-sm text-page disabled:opacity-50"
          >
            {t("web.base.write")}
          </button>
          <button
            type="button"
            disabled={busy()}
            onClick={() => setWriting(false)}
            class="h-7 shrink-0 cursor-pointer rounded-md border border-line px-2.5 text-sm"
          >
            {t("web.base.form.never")}
          </button>
        </form>
      </Show>
    </div>
  );
}

/** The helpers an agent sent, a list to pick from beside the picked one's trajectory. */
export function TrajectoryList(props: { agent: string }) {
  const heads = useQuery(() => ({ queryKey: ["sessions", props.agent], queryFn: () => api.session.list({ agent: props.agent }) }));
  const [picked, setPicked] = createSignal<string>();
  const now = useNow();
  const list = () => ready(heads, undefined);
  const open = () => {
    const all = list();
    return all?.find((h) => h.id === (picked() ?? all[0]?.id));
  };
  return (
    <Show when={list()} fallback={<Quiet>{heads.error ? reasonOf(heads.error) : t("web.base.reading")}</Quiet>}>
      {(all) => (
        <Show when={all().length > 0} fallback={<Quiet>{t("web.session.trajectory.neverSent")}</Quiet>}>
          <div class="flex h-full min-h-0 flex-col gap-3 md:flex-row">
            <ul aria-label={t("web.session.trajectory.sent")} class="flex max-h-33 shrink-0 flex-col gap-0.5 overflow-y-auto md:max-h-none md:w-60">
              <For each={all()} keyed={(h) => h.id}>
                {(h) => {
                  const ended = () => (h().phase._tag === "closed" ? (h().phase as { at: number }).at : undefined);
                  return (
                    <li>
                      <button
                        type="button"
                        aria-current={h().id === open()?.id ? "true" : undefined}
                        onClick={() => setPicked(h().id)}
                        class={[
                          "flex w-full cursor-pointer flex-col rounded-md px-2.5 py-1.5 text-left",
                          h().id === open()?.id ? "bg-selected" : "hover:bg-hover",
                        ]}
                      >
                        <span class="flex flex-wrap items-center gap-2">
                          <span class="text-sm font-medium">{h().name}</span>
                          <Show when={h().project}>
                            <span class="text-xs text-muted">{h().project}</span>
                          </Show>
                          <Show when={ended() === undefined}>
                            <span class="rounded bg-hat px-1.5 text-xs text-bark-900">{t("web.session.trajectory.here")}</span>
                          </Show>
                        </span>
                        <span class="text-xs text-muted">
                          {ended() === undefined
                            ? t("web.session.trajectory.hired", { ago: ago(h().hiredAt, now()) })
                            : t("web.session.trajectory.hiredAndLeft", { hired: ago(h().hiredAt, now()), left: ago(ended()!, now()) })}
                        </span>
                        <Show when={h().brief}>
                          <span class="truncate text-xs">{oneLine(h().brief)}</span>
                        </Show>
                      </button>
                    </li>
                  );
                }}
              </For>
            </ul>
            <div class="min-h-0 min-w-0 flex-1">
              <Show when={open()} fallback={<Quiet>{t("web.session.trajectory.pick")}</Quiet>}>
                {(o) => (
                  <Keyed key={o().id}>
                    {() => <TrajectoryLog id={o().id} title={o().brief ? `${o().name} · ${oneLine(o().brief)}` : o().name} about={o().brief} />}
                  </Keyed>
                )}
              </Show>
            </div>
          </div>
        </Show>
      )}
    </Show>
  );
}
