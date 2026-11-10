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

const logStyles = stylex.create({
  box: {
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  edge: {
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
  },
  faint: {
    fontStyle: "italic",
  },
  line: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
  },
  text: {
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  user: {
    backgroundColor: {
      default: "var(--wb-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-wheat) 14%, transparent)",
    },
  },
  memory: {
    backgroundColor: {
      default: "var(--wb-leaf)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-leaf) 15%, transparent)",
    },
  },
  assistant: {
    backgroundColor: "var(--wb-hover)",
  },
  retry: {
    backgroundColor: {
      default: "var(--wb-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-wheat) 12%, transparent)",
    },
  },
  usage: {
    backgroundColor: {
      default: "var(--wb-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-wheat) 6%, transparent)",
    },
  },
  error: {
    backgroundColor: {
      default: "var(--wb-berry)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-berry) 10%, transparent)",
    },
  },
  ink: {
    color: "var(--wb-ink)",
  },
  muted: {
    color: "var(--wb-muted)",
  },
  berry: {
    color: "var(--wb-berry)",
  },
  duration: {
    backgroundColor: {
      default: "var(--timeline-color)",
      "@media (hover: hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
});

const styles = stylex.create({
  foldedDiv: {
    width: "100%",
    overflow: "hidden",
  },
  foldedDivPrimary: {
    fontSize: null,
    lineHeight: null,
    whiteSpace: null,
  },
  foldedDivSecondary: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    whiteSpace: "pre-wrap",
  },
  foldedDivStateA: {
    WebkitMaskImage: null,
    maskImage: null,
  },
  foldedDivStateB: {
    WebkitMaskImage: "linear-gradient(black 70%,transparent)",
    maskImage: "linear-gradient(black 70%,transparent)",
  },
  runStepsWorkLog: {
    marginTop: "calc(var(--spacing) * 1.5)",
  },
  runStepsIcon: {
    opacity: ".6",
  },
  runFoldIcon: {
    transitionProperty: "transform,translate,scale,rotate",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".12s",
  },
  runFoldIconTone: {
    rotate: "90deg",
  },
  runFoldIconAlt: {},
  lineIcon: {
    marginTop: "var(--spacing)",
  },
  runFoldDiv: {},
  runFoldDivTone: {
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
  toolStepButtonTone: {
    backgroundColor: {
      default: "var(--color-hover)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  toolStepButtonAlt: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
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
  runFoldDiv2: {
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
  runFoldDiv22: {
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
  foldedDiv2: {
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
        <div {...stylex.attrs(styles.runStepsDiv)}>
          <button type="button" onClick={() => setOpen(!open())} aria-expanded={aria(open())} {...stylex.attrs(styles.runStepsButton)}>
            <Icon name="log" size={14} />
            {text()}
            <Icon name={open() ? "collapse" : "enlarge"} size={10} styles={[styles.runStepsIcon]} />
          </button>
          <Show when={open()}>
            <WorkLog steps={steps()} now={now()} asked={t("web.session.log.heard")} styles={[styles.runStepsWorkLog]} />
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
    <div {...styleProps([styles.workLog, props.styles])} aria-label={t("web.session.log.process")}>
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
    <div {...stylex.attrs(styles.runFoldDiv2, styles.runDivider)}>
      <button
        type="button"
        onClick={() => setToggled(!open())}
        aria-label={open() ? t("web.session.log.fold") : t("web.session.log.unfold")}
        {...stylex.attrs(styles.runFoldButton)}
      >
        <Icon name="expand" size={12} styles={[styles.runFoldIcon, open() ? styles.runFoldIconTone : styles.runFoldIconAlt]} />
        <span {...stylex.attrs(styles.runFoldSpan)}>{props.label}</span>
        <span {...stylex.attrs(styles.runFoldSpan2)}>
          {t("web.session.log.steps", { n: props.run.steps.length, took: tookText(runMs(props.run, end())) })}
          {props.live ? t("web.session.log.live") : ""}
        </span>
        <Show when={props.run.asked}>{(asked) => <When at={asked().time} now={props.now} />}</Show>
      </button>
      <Show when={props.run.asked}>
        {(asked) => (
          <div {...stylex.attrs(styles.runFoldDiv22)}>
            <Folded text={asked().text} lines={4} />
          </div>
        )}
      </Show>
      <Show when={props.run.steps.length > 0}>
        <TimeBar run={props.run} end={end()} />
      </Show>
      <For each={shown()} keyed={(s) => s.seq}>
        {(s) => (
          <div {...stylex.attrs(styles.runFoldDiv, s().under !== undefined ? styles.runFoldDivTone : styles.runFoldDiv)}>
            <Step step={s()} now={props.now} />
          </div>
        )}
      </For>
      <Show when={!open() && props.run.steps.length > shown().length}>
        <button type="button" onClick={() => setToggled(true)} {...stylex.attrs(styles.runFoldButton2)}>
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
    <div {...stylex.attrs(styles.timeBarDiv)}>
      <For each={spans()} keyed={(s) => s.step.seq}>
        {(s) => (
          <span
            title={`${spanLabel(s().step)} · ${tookText(s().ms)}\n${s().step.text.split("\n")[0]}`}
            {...styleProps(logStyles.duration)}
            style={{ "flex-grow": Math.max(1, Math.round((Math.max(s().ms, least()) / least()) * 10)), "--timeline-color": spanColor(s().step) }}
          />
        )}
      </For>
    </div>
  );
}

function When(props: { at: number; now: number }) {
  return <span {...stylex.attrs(styles.whenSpan)}>{ago(props.at, props.now)}</span>;
}

function Folded(props: { text: string; lines: number; markdown?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const long = () => isLongText(props.text, props.lines);
  const clamp = () => long() && !open();
  return (
    <div {...stylex.attrs(styles.foldedDiv2)}>
      <div
        {...stylex.attrs(
          styles.foldedDiv,
          props.markdown !== true ? styles.foldedDivSecondary : styles.foldedDivPrimary,
          clamp() ? styles.foldedDivStateB : styles.foldedDivStateA,
        )}
        style={clamp() ? { "max-height": `${props.lines * 22}px` } : undefined}
      >
        {props.markdown === true ? <Markdown text={props.text} /> : props.text}
      </div>
      <Show when={long()}>
        <button type="button" onClick={() => setOpen(!open())} {...stylex.attrs(styles.foldedButton)}>
          {open() ? t("web.session.log.less") : t("web.session.log.all")}
        </button>
      </Show>
    </div>
  );
}

function Box(props: { tint?: stylex.StyleXStyles; edge?: boolean; faint?: boolean; label: string; step: SessionEvent; now: number; children: JSX.Element }) {
  return (
    <div {...styleProps([logStyles.box, props.tint, props.edge === true && logStyles.edge, props.faint === true && logStyles.faint])}>
      <div {...stylex.attrs(styles.boxDiv)}>
        <span {...stylex.attrs(styles.boxSpan)}>{props.label}</span>
        <span {...stylex.attrs(styles.boxSpan2)} />
        <When at={props.step.time} now={props.now} />
      </div>
      {props.children}
    </div>
  );
}

function Line(props: { mark: IconName; step: SessionEvent; now: number; tint: stylex.StyleXStyles; ink: stylex.StyleXStyles }) {
  return (
    <div {...styleProps([logStyles.line, props.tint])}>
      <Icon name={props.mark} size={12} styles={[styles.lineIcon]} />
      <span {...styleProps([logStyles.text, props.ink])}>{props.step.text}</span>
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
        <Box tint={logStyles.user} label={sub() ? t("web.session.log.subagentGot") : t("web.session.log.told")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={4} />
        </Box>
      </Match>
      <Match when={props.step.type === "memory/recalled"}>
        <Box tint={logStyles.memory} label={t("web.session.log.recalled")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={3} />
        </Box>
      </Match>
      <Match when={props.step.type === "assistant/thinking"}>
        <Box edge faint label={sub() ? t("web.session.log.subagentThought") : t("web.session.log.thought")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={2} />
        </Box>
      </Match>
      <Match when={props.step.type === "assistant/message"}>
        <Box tint={logStyles.assistant} label={sub() ? t("web.session.log.subagentSaid") : t("web.session.log.said")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={8} markdown />
        </Box>
      </Match>
      <Match when={props.step.type === "tool/call"}>
        <ToolStep step={props.step} now={props.now} />
      </Match>
      <Match when={props.step.type === "llm/retry"}>
        <Line mark="retry" step={props.step} now={props.now} tint={logStyles.retry} ink={logStyles.ink} />
      </Match>
      <Match when={props.step.type === "llm/usage"}>
        <Line mark="spend" step={props.step} now={props.now} tint={logStyles.usage} ink={logStyles.muted} />
      </Match>
      <Match when={props.step.type === "run/error"}>
        <Line mark="warn" step={props.step} now={props.now} tint={logStyles.error} ink={logStyles.berry} />
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
        {...stylex.attrs(styles.toolStepButton, open() ? styles.toolStepButtonTone : styles.toolStepButtonAlt)}
      >
        <Icon name={actionIcon[props.step.action ?? "other"]} size={16} />
        <span {...stylex.attrs(styles.toolStepSpan)}>{kind()}</span>
        <span {...stylex.attrs(styles.toolStepSpan2)}>{farm() ?? props.step.text}</span>
        <span title={state()} {...stylex.attrs(styles.toolStepSpan3)}>
          <Show when={props.step.ok !== undefined} fallback={<span {...stylex.attrs(styles.toolStepSpan4)}>…</span>}>
            <Icon name={props.step.ok === true ? "check" : "cross"} size={12} label={state()} />
          </Show>
        </span>
        <When at={props.step.time} now={props.now} />
      </button>
      <Show when={open()}>
        <div {...stylex.attrs(styles.toolStepDiv)}>
          {props.step.tool && <span {...stylex.attrs(styles.toolStepSpan5)}>{t("web.session.log.tool", { name: props.step.tool })}</span>}
          <Show when={input()}>{(text) => <pre {...stylex.attrs(styles.toolStepPre)}>{text()}</pre>}</Show>
          <Show
            when={props.step.output}
            fallback={
              <span {...stylex.attrs(styles.toolStepSpan5)}>
                {props.step.ok === undefined ? t("web.session.log.pending") : t("web.session.log.noOutput")}
              </span>
            }
          >
            {(out) => <pre {...stylex.attrs(styles.toolStepPre2)}>{out()}</pre>}
          </Show>
        </div>
      </Show>
    </div>
  );
}
