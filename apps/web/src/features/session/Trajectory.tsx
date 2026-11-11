import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, Switch, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { OrchestratorEval, SessionEvent } from "@vibevalley/protocol";
import { omitUndefined, oneLine } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { aria, autofocus, Keyed, useNow } from "#/base/dom.tsx";
import { ago } from "#/base/format.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { defineQuery, retryRead, ready, useQuery } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Quiet } from "#/ui/layout.tsx";
import { Markdown } from "#/ui/Markdown.tsx";
import { styleProps } from "#/ui/positioner.ts";

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

const trajectoryStyles = stylex.create({
  bar: {
    position: "absolute",
    height: "0.75rem",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    backgroundColor: {
      default: "var(--timeline-color)",
      "@media (hover: hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
  round: {
    position: "relative",
  },
  report: {
    position: "absolute",
    top: "0",
    right: "0",
    display: {
      default: "none",
      [stylex.when.ancestor(":focus-within")]: "flex",
      "@media (hover: hover)": {
        default: null,
        [stylex.when.ancestor(":hover")]: "flex",
      },
    },
    cursor: "pointer",
    alignItems: "center",
    gap: "0.25rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-medium)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
});

const styles = stylex.create({
  toolDetailPre: {
    fontFamily: "var(--font-mono)",
    whiteSpace: "pre-wrap",
    WebkitUserSelect: "text",
    userSelect: "text",
  },
  rowSpan: {
    width: "3.75rem",
    flexShrink: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    paddingTop: "0.125rem",
    paddingLeft: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  rowSpan2: {
    marginTop: "1px",
    flexShrink: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    borderRadius: "var(--radius-sm)",
    paddingInline: "0.25rem",
    paddingBlock: "1px",
    textAlign: "center",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-medium)",
  },
  rowSpanPrimary: {
    width: "5.5rem",
    marginLeft: null,
  },
  rowSpanSecondary: {
    width: "78px",
    marginLeft: "0.625rem",
  },
  waterfallViewDiv: {
    display: "flex",
    width: "3.75rem",
    flexShrink: "0",
    flexDirection: "column",
    justifyContent: "space-between",
    paddingLeft: "0.5rem",
  },
  rowIcon: {
    marginTop: "0.25rem",
    marginRight: "0.25rem",
  },
  trajectoryTextInput: {
    width: {
      default: "9rem",
      "@media (width>=40rem)": "14rem",
    },
  },
  rowDiv: {
    borderRadius: "var(--radius-md)",
    paddingBlock: "3px",
    paddingRight: "0.5rem",
  },
  rowDivTone: {
    backgroundColor: {
      default: "var(--color-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-wheat) 35%, transparent)",
    },
  },
  rowDivAlt: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  rowSpan3: {
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  rowSpanTone: {
    color: "var(--color-berry)",
  },
  rowSpanAlt: {},
  toolLineSpan: {
    fontFamily: "var(--font-mono)",
  },
  trajectoryListButton: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    flexDirection: "column",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
    textAlign: "left",
  },
  trajectoryListButtonTone: {
    backgroundColor: "var(--color-selected)",
  },
  headSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
  },
  trajectoryLogDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  trajectoryDiv: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: "column",
  },
  trajectoryDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    paddingBottom: "0.5rem",
  },
  trajectoryDiv3: {
    minWidth: "0",
    flex: "1",
  },
  trajectoryDiv4: {
    marginTop: "0.5rem",
    minHeight: "0",
    flex: "1",
    overflowY: "auto",
    borderBlockStyle: "solid",
    borderBlockWidth: "1px",
    borderColor: "var(--color-line)",
    paddingBlock: "0.25rem",
  },
  stepsEmpty: {
    paddingTop: "0.5rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  trajectoryP: {
    paddingTop: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  rowButton: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "flex-start",
    textAlign: "left",
  },
  rowSpan4: {
    width: "0.5rem",
    flexShrink: "0",
  },
  rowSpan22: {
    display: "block",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  rowSpan32: {
    whiteSpace: "pre-wrap",
  },
  rowSpan42: {
    flexShrink: "0",
    paddingTop: "0.125rem",
    paddingLeft: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  toolLineSpan2: {
    fontFamily: "var(--font-mono)",
    color: "var(--color-muted)",
  },
  toolDetailDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    paddingTop: "0.25rem",
    paddingBottom: "0.375rem",
    paddingLeft: "164px",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  toolDetailSpan: {
    color: "var(--color-muted)",
  },
  waterfallViewDiv2: {
    display: "flex",
    height: "2.5rem",
  },
  waterfallViewSpan: {
    fontSize: "var(--text-2xs)",
    lineHeight: "1",
    color: "var(--color-muted)",
  },
  waterfallViewDiv22: {
    position: "relative",
    minWidth: "0",
    flex: "1",
    overflow: "hidden",
  },
  waterfallViewDiv3: {
    position: "absolute",
    insetInline: "0",
    height: "0.75rem",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-hover)",
  },
  markableDiv: {
    marginBlock: "0.125rem",
    marginRight: "0.5rem",
    marginLeft: "164px",
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    borderRadius: "var(--radius-md)",
    backgroundColor: {
      default: "var(--color-berry)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-berry) 12%, transparent)",
    },
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  markableForm: {
    marginBlock: "0.25rem",
    marginRight: "0.5rem",
    marginLeft: "164px",
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  markSubmit: {
    height: "1.75rem",
    flexShrink: "0",
    cursor: "pointer",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-accent)",
    paddingInline: "0.625rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-page)",
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  markableButton: {
    height: "1.75rem",
    flexShrink: "0",
    cursor: "pointer",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "0.625rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  trajectoryListDiv: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: {
      default: "column",
      "@media (width>=48rem)": "row",
    },
    gap: "0.75rem",
  },
  trajectoryListUl: {
    display: "flex",
    maxHeight: {
      default: "8.25rem",
      "@media (width>=48rem)": "none",
    },
    flexShrink: "0",
    flexDirection: "column",
    gap: "0.125rem",
    overflowY: "auto",
    width: {
      default: null,
      "@media (width>=48rem)": "15rem",
    },
  },
  trajectoryListSpan: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
  trajectoryListSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-medium)",
  },
  trajectoryListSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  trajectoryListSpan4: {
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-hat)",
    paddingInline: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-bark-900)",
  },
  trajectoryListSpan5: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  trajectoryListDiv2: {
    minHeight: "0",
    minWidth: "0",
    flex: "1",
  },
});

/** Saves the model turn its user/message `step` began as a case of the orchestrator's evals; `want` is what it should have done. */
type MarkWrong = (step: number, want: string) => Promise<OrchestratorEval>;

const laneNames: Record<Lane, string> = {
  asked: t("web.session.trajectory.lane.asked"),
  model: t("web.session.trajectory.lane.model"),
  tool: t("web.session.trajectory.lane.tool"),
};

// Usage is not a step of the work: the page's own hover ground, with the theme's ink, in either theme.
const tagFill = (step: SessionEvent) => (step.type === "llm/usage" ? "var(--color-hover)" : step.type === "llm/retry" ? "#f1dcab" : spanColor(step));

const lightInk = "#fffaf0";
const darkInk = "#2f1f13";

const luminance = (hex: string) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/iu.exec(hex);
  if (!m) return 1;
  const [r = 0, g = 0, b = 0] = m.slice(1).map((h) => parseInt(h, 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** The words on a fill: whichever ink stands out more from it (WCAG's ratio), so a mid-tone fill gets the readable one. */
function inkOn(fill: string) {
  if (!/^#[0-9a-f]{6}$/iu.test(fill)) return "var(--color-ink)";
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
export function TrajectoryLog(props: { id: string; asked?: string; empty?: string; onMarkWrong?: MarkWrong; title?: string; about?: string }) {
  const steps = createSessionEvents(
    () => props.id,
    () => true,
  );
  const now = useNow();
  const head = () =>
    props.title ? (
      <span {...stylex.attrs(styles.headSpan)} title={props.about}>
        {props.title}
      </span>
    ) : undefined;
  return (
    <Show
      when={steps().length > 0}
      fallback={
        <div {...stylex.attrs(styles.trajectoryLogDiv)}>
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
  // The messages marked wrong here, by their step: the case's file.
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
    return props.working === true && props.now > last ? props.now : last;
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

  const toggle = (n: number) => setOpen((o) => (o.has(n) ? new Set([...o].filter((x) => x !== n)) : new Set([...o, n])));

  return (
    <div {...stylex.attrs(styles.trajectoryDiv)}>
      <div {...stylex.attrs(styles.trajectoryDiv2)}>
        <div {...stylex.attrs(styles.trajectoryDiv3)}>{props.head}</div>
        <TextInput
          data-testid="trajectory-search"
          aria-label={t("web.session.trajectory.search")}
          placeholder={t("web.session.trajectory.searchHint")}
          styles={styles.trajectoryTextInput}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      <WaterfallView
        steps={props.steps}
        end={end()}
        colorOf={(seq) => {
          const s = bySeq().get(seq);
          return s ? spanColor(s) : "var(--color-bark-400)";
        }}
        onPick={show}
      />
      <div
        ref={(el) => (scroller = el)}
        {...stylex.attrs(styles.trajectoryDiv4)}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        <Show
          when={rows().length > 0}
          fallback={
            <p data-testid="steps-empty" {...stylex.attrs(styles.stepsEmpty)}>
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
      <p {...stylex.attrs(styles.trajectoryP)}>{summaryText(summaryOf(props.steps, end()))}</p>
    </div>
  );
}

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
      {...stylex.attrs(styles.rowDiv, props.marked ? styles.rowDivTone : styles.rowDivAlt)}
    >
      <button
        type="button"
        aria-label={`${props.spec.tag} ${oneLine(step().text).trim()}`}
        aria-expanded={aria(props.open)}
        onClick={() => props.onToggle()}
        {...stylex.attrs(styles.rowButton)}
      >
        <span {...stylex.attrs(styles.rowSpan)}>{props.spec.gutter}</span>
        <span
          {...stylex.attrs(styles.rowSpan2, sub() ? styles.rowSpanSecondary : styles.rowSpanPrimary)}
          style={{ background: sub() && fill().startsWith("#") ? `${fill()}8c` : fill(), color: inkOn(fill()) }}
        >
          {props.spec.tag}
        </span>
        <span {...stylex.attrs(styles.rowSpan4)} />
        <Show when={failed() && tool()}>
          <Icon name="cross" size={12} styles={[styles.rowIcon]} />
        </Show>
        <span {...stylex.attrs(styles.rowSpan3, failed() ? styles.rowSpanTone : styles.rowSpanAlt)}>
          <Switch fallback={<span {...stylex.attrs(styles.rowSpan22)}>{oneLine(step().text).trim()}</span>}>
            <Match when={tool()}>
              <ToolLine step={step()} />
            </Match>
            <Match when={props.open && step().type === "assistant/message"}>
              <Markdown text={step().text} />
            </Match>
            <Match when={props.open}>
              <span {...stylex.attrs(styles.rowSpan32)}>{step().text}</span>
            </Match>
          </Switch>
        </span>
        <Show when={props.spec.when}>
          <span {...stylex.attrs(styles.rowSpan42)}>{props.spec.when}</span>
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
  const args = () => oneLine(props.step.input ?? "").trim();
  const out = () => oneLine(props.step.output ?? "").trim();
  return (
    <span {...stylex.attrs(styles.rowSpan22)}>
      {farmToolText(props.step.text) ?? props.step.text}
      <Show when={args()}>
        <span {...stylex.attrs(styles.toolLineSpan2)}> {args()}</span>
      </Show>
      {" → "}
      <Switch
        fallback={
          <span {...stylex.attrs(styles.toolLineSpan, props.step.ok === false ? styles.rowSpanTone : styles.rowSpanAlt)}>
            {out()}
          </span>
        }
      >
        <Match when={props.step.ok === undefined}>{t("web.session.trajectory.pending")}</Match>
        <Match when={!out()}>{t("web.session.trajectory.noOutput")}</Match>
      </Switch>
    </span>
  );
}

function ToolDetail(props: { step: SessionEvent }) {
  const input = () => readableInput(props.step);
  return (
    <div {...stylex.attrs(styles.toolDetailDiv)}>
      <span {...stylex.attrs(styles.toolDetailSpan)}>
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
        <span {...stylex.attrs(styles.toolDetailSpan)}>{t("web.session.trajectory.input")}</span>
        <pre {...stylex.attrs(styles.toolDetailPre)}>{input()}</pre>
      </Show>
      <span {...stylex.attrs(styles.toolDetailSpan)}>{t("web.session.trajectory.output")}</span>
      <Show
        when={props.step.output}
        fallback={
          <span {...stylex.attrs(styles.toolDetailSpan)}>
            {props.step.ok === undefined ? t("web.session.trajectory.pending") : t("web.session.trajectory.noOutput")}
          </span>
        }
      >
        <pre {...stylex.attrs(styles.toolDetailPre)}>{props.step.output}</pre>
      </Show>
    </div>
  );
}

/** Runs side by side by how long each took; the idle time between them is a fixed gap. */
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
        color: span.lane === "asked" ? "var(--color-wheat)" : span.lane === "model" ? "var(--color-leaf)" : props.colorOf(span.seq),
      };
    });
  });
  return (
    <div {...stylex.attrs(styles.waterfallViewDiv2)}>
      <div {...stylex.attrs(styles.waterfallViewDiv)}>
        <For each={lanes}>{(l) => <span {...stylex.attrs(styles.waterfallViewSpan)}>{laneNames[l]}</span>}</For>
      </div>
      <div ref={(el) => (box = el)} {...stylex.attrs(styles.waterfallViewDiv22)}>
        <For each={[0, 1, 2]}>
          {(i) => <div {...stylex.attrs(styles.waterfallViewDiv3)} style={{ top: `${i * (lane + gap)}px` }} />}
        </For>
        <For each={bars()} keyed={false}>
          {(b) => (
            <button
              type="button"
              title={b().label}
              aria-label={b().label}
              onClick={() => props.onPick(b().seq)}
              {...styleProps(trajectoryStyles.bar)}
              style={{ left: `${b().left}px`, width: `${b().width - 1}px`, top: `${b().top}px`, "--timeline-color": b().color }}
            />
          )}
        </For>
      </div>
    </div>
  );
}

/** Mark round wrong floats over a message it heard. */
function Markable(props: { step: number; send: MarkWrong; file?: string | undefined; onMarked: (file: string) => void; children: JSX.Element }) {
  const [writing, setWriting] = createSignal(false);
  const act = createAct();
  const busy = act.busy;
  const [want, setWant] = createSignal("");
  const submit = async () => {
    const w = want().trim();
    if (!w || busy()) return;
    const step = props.step;
    const send = props.send;
    const got = await act.run(() => send(step, w));
    if (!got) return;
    setWriting(false);
    props.onMarked(got.file);
  };
  return (
    <div data-testid="round" data-key={props.step} data-marked={props.file ? "" : undefined} {...styleProps([stylex.defaultMarker(), trajectoryStyles.round])}>
      {props.children}
      <Show when={!props.file && !writing()}>
        <button type="button" data-testid="mark-wrong" onClick={() => setWriting(true)} {...styleProps(trajectoryStyles.report)}>
          <Icon name="bug" size={12} />
          {t("web.session.trajectory.wrong")}
        </button>
      </Show>
      <Show when={props.file}>
        <div title={props.file} {...stylex.attrs(styles.markableDiv)}>
          <Icon name="bug" size={12} />
          {t("web.session.trajectory.marked")}
        </div>
      </Show>
      <Show when={writing()}>
        <form
          {...stylex.attrs(styles.markableForm)}
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
          <button type="submit" data-testid="mark-submit" disabled={busy() || !want().trim()} {...stylex.attrs(styles.markSubmit)}>
            {t("web.base.write")}
          </button>
          <button type="button" disabled={busy()} onClick={() => setWriting(false)} {...stylex.attrs(styles.markableButton)}>
            {t("web.base.form.never")}
          </button>
        </form>
      </Show>
    </div>
  );
}

/** The helpers an agent sent, a list to pick from beside the picked one's trajectory. */
const sessionsQuery = defineQuery({
  schema: Schema.mutable(Schema.Array(S.Session)),
  key: (agent: string) => ["sessions", agent],
  fetch: (agent, context) => api.session.list({ agent }, context),
  ...retryRead,
});
export function TrajectoryList(props: { agent: string }) {
  const heads = useQuery(() => sessionsQuery(props.agent));
  const [picked, setPicked] = createSignal<string>();
  const now = useNow();
  const list = () => ready(heads, undefined);
  const open = () => {
    const all = list();
    return all?.find((h) => h.id === (picked() ?? all[0]?.id));
  };
  return (
    <Show when={list()} fallback={<Quiet>{heads.error() ? reasonOf(heads.error()) : t("web.base.reading")}</Quiet>}>
      {(all) => (
        <Show when={all().length > 0} fallback={<Quiet>{t("web.session.trajectory.neverSent")}</Quiet>}>
          <div {...stylex.attrs(styles.trajectoryListDiv)}>
            <ul aria-label={t("web.session.trajectory.sent")} {...stylex.attrs(styles.trajectoryListUl)}>
              <For each={all()} keyed={(h) => h.id}>
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
                    <li>
                      <button
                        type="button"
                        aria-current={h().id === open()?.id ? "true" : undefined}
                        onClick={() => setPicked(h().id)}
                        {...stylex.attrs(
                          styles.trajectoryListButton,
                          h().id === open()?.id ? styles.trajectoryListButtonTone : styles.rowDivAlt,
                        )}
                      >
                        <span {...stylex.attrs(styles.trajectoryListSpan)}>
                          <span {...stylex.attrs(styles.trajectoryListSpan2)}>{h().name}</span>
                          <Show when={h().repo}>
                            <span {...stylex.attrs(styles.trajectoryListSpan3)}>{h().repo}</span>
                          </Show>
                          <Show when={ended() === undefined}>
                            <span {...stylex.attrs(styles.trajectoryListSpan4)}>{t("web.session.trajectory.here")}</span>
                          </Show>
                        </span>
                        <span {...stylex.attrs(styles.trajectoryListSpan3)}>{sentText()}</span>
                        <Show when={h().brief}>
                          <span {...stylex.attrs(styles.trajectoryListSpan5)}>{oneLine(h().brief).trim()}</span>
                        </Show>
                      </button>
                    </li>
                  );
                }}
              </For>
            </ul>
            <div {...stylex.attrs(styles.trajectoryListDiv2)}>
              <Show when={open()} fallback={<Quiet>{t("web.session.trajectory.pick")}</Quiet>}>
                {(o) => (
                  <Keyed key={o().id}>
                    {() => <TrajectoryLog id={o().id} title={o().brief ? `${o().name} · ${oneLine(o().brief).trim()}` : o().name} about={o().brief} />}
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
