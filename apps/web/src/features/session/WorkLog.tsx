import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { SessionEvent } from "@vibevalley/protocol";

import { aria, useNow } from "#/base/dom.tsx";
import { ago, tookText } from "#/base/format.ts";
import { Icon } from "#/ui/Icon.tsx";
import { actionIcon, type IconName } from "#/ui/icons.ts";
import { Markdown } from "#/ui/Markdown.tsx";
import { styleProps } from "#/ui/positioner.ts";

import { createSessionEvents } from "./events";
import {
  answerOf,
  farmToolText,
  isLongText,
  lastTime,
  readableInput,
  runLabel,
  runMs,
  runsOf,
  runTitle,
  type RunView,
  shownEvents,
  spanColor,
  spanLabel,
  spansOf,
} from "./runs";

const recipeStyles = stylex.create({
  runStepsWorkLog: {
    marginTop: "calc(var(--spacing) * 1.5)",
  },
});

const variantStyles2 = stylex.create({
  runStepsIcon: {
    opacity: ".6",
  },
  runFoldIcon: {
    transitionProperty: "transform,translate,scale,rotate",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".12s",
  },
  runFoldIconVariant: {
    rotate: "90deg",
  },
  runFoldIconVariant2: {},
  lineIcon: {
    marginTop: "var(--spacing)",
  },
});

const variantStyles = stylex.create({
  runFoldDiv: {},
  runFoldDivVariant: {
    marginLeft: "calc(var(--spacing) * 5)",
    borderLeftStyle: "solid",
    borderLeftWidth: "2px",
    borderColor: {
      default: "var(--color-leaf)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf) 50%, transparent)",
    },
    paddingLeft: "calc(var(--spacing) * 2.5)",
  },
  toolStepButton: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    textAlign: "left",
  },
  toolStepButtonVariant: {
    backgroundColor: {
      default: "var(--color-hover)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  toolStepButtonVariant2: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
});

const viewStyles = stylex.create({
  workLog: {
    maxHeight: "352px",
    overflowY: "auto",
    borderRadius: "var(--radius-md)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
  },
  runDivider: {
    borderTopWidth: { default: null, ":not(:last-child)": 0 },
    borderBottomWidth: { default: null, ":not(:last-child)": 1 },
    borderTopStyle: { default: null, ":not(:last-child)": "solid" },
    borderBottomStyle: { default: null, ":not(:last-child)": "solid" },
    borderColor: { default: null, ":not(:last-child)": "var(--color-line)" },
  },
  runStepsDiv: {
    marginTop: "calc(var(--spacing) * 1.5)",
  },
  runStepsButton: {
    display: "inline-flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-muted)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  runFoldDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingTop: "calc(var(--spacing) * 2)",
    paddingBottom: "calc(var(--spacing) * 2.5)",
  },
  runFoldButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "var(--spacing)",
    textAlign: "left",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  runFoldSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  runFoldSpan2: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  runFoldDiv2: {
    borderRadius: "var(--radius-md)",
    backgroundColor: {
      default: "var(--color-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-wheat) 15%, transparent)",
    },
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  runFoldButton2: {
    cursor: "pointer",
    alignSelf: "flex-start",
    paddingLeft: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  timeBarDiv: {
    display: "flex",
    height: "calc(var(--spacing) * 2)",
    gap: "1px",
    overflow: "hidden",
    borderRadius: "var(--radius-xs)",
  },
  whenSpan: {
    flexShrink: "0",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  foldedDiv: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
  },
  foldedButton: {
    marginTop: "var(--spacing)",
    cursor: "pointer",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  boxDiv: {
    marginBottom: "var(--spacing)",
    display: "flex",
    alignItems: "center",
  },
  boxSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  boxSpan2: {
    flex: "1",
  },
  toolStepSpan: {
    width: "calc(var(--spacing) * 16)",
    flexShrink: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
  toolStepSpan2: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  toolStepSpan3: {
    flexShrink: "0",
  },
  toolStepSpan4: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-faint)",
  },
  toolStepDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
    paddingTop: "var(--spacing)",
    paddingRight: "calc(var(--spacing) * 2)",
    paddingBottom: "calc(var(--spacing) * 2)",
    paddingLeft: "calc(var(--spacing) * 8)",
  },
  toolStepSpan5: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  toolStepPre: {
    maxHeight: "calc(var(--spacing) * 40)",
    overflow: "auto",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-code-bg)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    whiteSpace: "pre-wrap",
    color: "var(--color-code-ink)",
  },
  toolStepPre2: {
    maxHeight: "calc(var(--spacing) * 56)",
    overflow: "auto",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    whiteSpace: "pre-wrap",
  },
});

/** Under a report or the orchestrator's answer: the run behind it, folded to one line until opened. */
export function RunSteps(props: { session: string; run: string | undefined; orchestrator?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const all = createSessionEvents(
    () => props.session,
    () => !!props.run,
  );
  const steps = () => all().filter((e) => e.run === props.run);
  const label = () => (props.run ? runLabel(steps(), props.orchestrator ?? false) : undefined);
  const now = useNow();
  return (
    <Show when={label()}>
      {(text) => (
        <div {...stylex.attrs(viewStyles.runStepsDiv)}>
          <button type="button" onClick={() => setOpen(!open())} aria-expanded={aria(open())} {...stylex.attrs(viewStyles.runStepsButton)}>
            <Icon name="log" size={14} />
            {text()}
            <Icon name={open() ? "collapse" : "enlarge"} size={10} styles={[variantStyles2.runStepsIcon]} />
          </button>
          <Show when={open()}>
            <WorkLog steps={steps()} now={now()} asked={t("web.session.log.heard")} styles={[recipeStyles.runStepsWorkLog]} />
          </Show>
        </div>
      )}
    </Show>
  );
}

/** A session's steps by run, each run folded to its answer but the last. */
export function WorkLog(props: { steps: SessionEvent[]; now: number; asked?: string; working?: boolean; styles?: stylex.StyleXStyles }) {
  const shown = () => shownEvents(props.steps);
  const runs = () => runsOf(shown());
  const firstAsked = () => shown().find((s) => s.type === "user/message" && s.under === undefined)?.seq;
  return (
    <div {...styleProps([viewStyles.workLog, props.styles])} aria-label={t("web.session.log.process")}>
      <For each={runs()} keyed={(r) => r.run ?? (r.asked ?? r.steps[0])?.seq ?? -1}>
        {(r, i) => (
          <RunFold
            run={r()}
            last={i() === runs().length - 1}
            live={!(props.working !== true) && i() === runs().length - 1}
            now={props.now}
            label={runTitle(r(), firstAsked(), props.asked)}
          />
        )}
      </For>
    </div>
  );
}

function RunFold(props: { run: RunView; last: boolean; live: boolean; now: number; label: string }) {
  const [toggled, setToggled] = createSignal<boolean>();
  const open = () => toggled() ?? props.last;
  const end = () => (props.live ? props.now : (lastTime(props.run) ?? props.now));
  const shown = () => {
    const answer = answerOf(props.run);
    return open() ? props.run.steps : answer ? [answer] : [];
  };
  return (
    <div {...stylex.attrs(viewStyles.runFoldDiv, viewStyles.runDivider)}>
      <button
        type="button"
        onClick={() => setToggled(!open())}
        aria-label={open() ? t("web.session.log.fold") : t("web.session.log.unfold")}
        {...stylex.attrs(viewStyles.runFoldButton)}
      >
        <Icon name="expand" size={12} styles={[variantStyles2.runFoldIcon, open() ? variantStyles2.runFoldIconVariant : variantStyles2.runFoldIconVariant2]} />
        <span {...stylex.attrs(viewStyles.runFoldSpan)}>{props.label}</span>
        <span {...stylex.attrs(viewStyles.runFoldSpan2)}>
          {t("web.session.log.steps", { n: props.run.steps.length, took: tookText(runMs(props.run, end())) })}
          {props.live ? t("web.session.log.live") : ""}
        </span>
        <Show when={props.run.asked}>{(asked) => <When at={asked().time} now={props.now} />}</Show>
      </button>
      <Show when={props.run.asked}>
        {(asked) => (
          <div {...stylex.attrs(viewStyles.runFoldDiv2)}>
            <Folded text={asked().text} lines={4} />
          </div>
        )}
      </Show>
      <Show when={props.run.steps.length > 0}>
        <TimeBar run={props.run} end={end()} />
      </Show>
      <For each={shown()} keyed={(s) => s.seq}>
        {(s) => (
          <div {...stylex.attrs(variantStyles.runFoldDiv, s().under !== undefined ? variantStyles.runFoldDivVariant : variantStyles.runFoldDiv)}>
            <Step step={s()} now={props.now} />
          </div>
        )}
      </For>
      <Show when={!open() && props.run.steps.length > shown().length}>
        <button type="button" onClick={() => setToggled(true)} {...stylex.attrs(viewStyles.runFoldButton2)}>
          {t("web.session.log.see", { n: props.run.steps.length })}
        </button>
      </Show>
    </div>
  );
}

function TimeBar(props: { run: RunView; end: number }) {
  const spans = () => spansOf(props.run, props.end);
  // The shortest span still shows: at least 1/80 of the bar.
  const least = () => {
    const total = spans().reduce((n, s) => n + s.ms, 0);
    return total <= 0 ? 1 : total / 80;
  };
  return (
    <div {...stylex.attrs(viewStyles.timeBarDiv)}>
      <For each={spans()} keyed={(s) => s.step.seq}>
        {(s) => (
          <span
            title={`${spanLabel(s().step)} · ${tookText(s().ms)}\n${s().step.text.split("\n")[0]}`}
            class="hover:!bg-ink"
            style={{ "flex-grow": Math.max(1, Math.round((Math.max(s().ms, least()) / least()) * 10)), background: spanColor(s().step) }}
          />
        )}
      </For>
    </div>
  );
}

function When(props: { at: number; now: number }) {
  return <span {...stylex.attrs(viewStyles.whenSpan)}>{ago(props.at, props.now)}</span>;
}

function Folded(props: { text: string; lines: number; markdown?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const long = () => isLongText(props.text, props.lines);
  const clamp = () => long() && !open();
  return (
    <div {...stylex.attrs(viewStyles.foldedDiv)}>
      <div
        class={["w-full overflow-hidden", { "text-base whitespace-pre-wrap": props.markdown !== true, "fold-fade": clamp() }]}
        style={clamp() ? { "max-height": `${props.lines * 22}px` } : undefined}
      >
        {props.markdown === true ? <Markdown text={props.text} /> : props.text}
      </div>
      <Show when={long()}>
        <button type="button" onClick={() => setOpen(!open())} {...stylex.attrs(viewStyles.foldedButton)}>
          {open() ? t("web.session.log.less") : t("web.session.log.all")}
        </button>
      </Show>
    </div>
  );
}

/** tint: the box's ground, a palette class (bg-wheat/14…), so it follows the theme. */
function Box(props: { tint?: string; edge?: boolean; faint?: boolean; label: string; step: SessionEvent; now: number; children: JSX.Element }) {
  return (
    <div class={["rounded-md px-3 py-2", props.tint, { "border border-line": !(props.edge !== true), italic: !(props.faint !== true) }]}>
      <div {...stylex.attrs(viewStyles.boxDiv)}>
        <span {...stylex.attrs(viewStyles.boxSpan)}>{props.label}</span>
        <span {...stylex.attrs(viewStyles.boxSpan2)} />
        <When at={props.step.time} now={props.now} />
      </div>
      {props.children}
    </div>
  );
}

function Line(props: { mark: IconName; step: SessionEvent; now: number; tint: string; ink: string }) {
  return (
    <div class={["flex items-start gap-2 rounded-md px-3 py-1.5", props.tint]}>
      <Icon name={props.mark} size={12} styles={[variantStyles2.lineIcon]} />
      <span class={["min-w-0 flex-1 text-sm", props.ink]}>{props.step.text}</span>
      <When at={props.step.time} now={props.now} />
    </div>
  );
}

function Step(props: { step: SessionEvent; now: number }) {
  const sub = () => props.step.under !== undefined;
  // Not rows: a run's bounds (each step carries its run), a result is shown in its call (shownEvents).
  return (
    <Switch>
      <Match when={props.step.type === "user/message"}>
        <Box tint="bg-wheat/14" label={sub() ? t("web.session.log.subagentGot") : t("web.session.log.told")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={4} />
        </Box>
      </Match>
      <Match when={props.step.type === "memory/recalled"}>
        <Box tint="bg-leaf/15" label={t("web.session.log.recalled")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={3} />
        </Box>
      </Match>
      <Match when={props.step.type === "assistant/thinking"}>
        <Box edge faint label={sub() ? t("web.session.log.subagentThought") : t("web.session.log.thought")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={2} />
        </Box>
      </Match>
      <Match when={props.step.type === "assistant/message"}>
        <Box tint="bg-hover" label={sub() ? t("web.session.log.subagentSaid") : t("web.session.log.said")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={8} markdown />
        </Box>
      </Match>
      <Match when={props.step.type === "tool/call"}>
        <ToolStep step={props.step} now={props.now} />
      </Match>
      <Match when={props.step.type === "llm/retry"}>
        <Line mark="retry" step={props.step} now={props.now} tint="bg-wheat/12" ink="text-ink" />
      </Match>
      <Match when={props.step.type === "llm/usage"}>
        <Line mark="spend" step={props.step} now={props.now} tint="bg-wheat/6" ink="text-muted" />
      </Match>
      <Match when={props.step.type === "run/error"}>
        <Line mark="warn" step={props.step} now={props.now} tint="bg-berry/10" ink="text-berry" />
      </Match>
    </Switch>
  );
}

function ToolStep(props: { step: SessionEvent; now: number }) {
  const [open, setOpen] = createSignal(false);
  const farm = () => farmToolText(props.step.text);
  const kind = () => (farm() ? t("web.session.log.farm") : (props.step.actionText ?? ""));
  const input = () => readableInput(props.step);
  const state = () => (props.step.ok === undefined ? t("web.session.log.running") : props.step.ok ? t("web.session.log.ok") : t("web.session.log.failed"));
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open())}
        aria-expanded={aria(open())}
        {...stylex.attrs(variantStyles.toolStepButton, open() ? variantStyles.toolStepButtonVariant : variantStyles.toolStepButtonVariant2)}
      >
        <Icon name={actionIcon[props.step.action ?? "other"]} size={16} />
        <span {...stylex.attrs(viewStyles.toolStepSpan)}>{kind()}</span>
        <span {...stylex.attrs(viewStyles.toolStepSpan2)}>{farm() ?? props.step.text}</span>
        <span title={state()} {...stylex.attrs(viewStyles.toolStepSpan3)}>
          <Show when={props.step.ok !== undefined} fallback={<span {...stylex.attrs(viewStyles.toolStepSpan4)}>…</span>}>
            <Icon name={props.step.ok === true ? "check" : "cross"} size={12} label={state()} />
          </Show>
        </span>
        <When at={props.step.time} now={props.now} />
      </button>
      <Show when={open()}>
        <div {...stylex.attrs(viewStyles.toolStepDiv)}>
          {props.step.tool && <span {...stylex.attrs(viewStyles.toolStepSpan5)}>{t("web.session.log.tool", { name: props.step.tool })}</span>}
          <Show when={input()}>{(text) => <pre {...stylex.attrs(viewStyles.toolStepPre)}>{text()}</pre>}</Show>
          <Show
            when={props.step.output}
            fallback={
              <span {...stylex.attrs(viewStyles.toolStepSpan5)}>
                {props.step.ok === undefined ? t("web.session.log.pending") : t("web.session.log.noOutput")}
              </span>
            }
          >
            {(out) => <pre {...stylex.attrs(viewStyles.toolStepPre2)}>{out()}</pre>}
          </Show>
        </div>
      </Show>
    </div>
  );
}
