import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { SessionEvent } from "@vibevalley/protocol";
import {
  answerOf,
  farmToolText,
  isLongText,
  lastTime,
  readableInput,
  type Round,
  roundLabel,
  roundMs,
  roundsOf,
  shownEvents,
  spanColor,
  spanLabel,
  spansOf,
  turnLabel,
} from "../../rules/rounds";
import { ago, tookText } from "../../rules/time";
import { aria, useNow } from "../../app/util";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { createSessionEvents } from "./data";

/** Under a report or the manager's answer: the run behind it, folded to one line until opened. */
export function TurnSteps(props: { session: string; run: string | undefined; manager?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const all = createSessionEvents(
    () => props.session,
    () => !!props.run,
  );
  const steps = () => all().filter((e) => e.run === props.run);
  const label = () => (props.run ? turnLabel(steps(), props.manager ?? false) : undefined);
  const now = useNow();
  return (
    <Show when={label()}>
      {(text) => (
        <div class="mt-1.5">
          <button
            type="button"
            onClick={() => setOpen(!open())}
            aria-expanded={aria(open())}
            class="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted hover:bg-hover"
          >
            <Icon name="icon-log" size={14} />
            {text()}
            <Icon name={open() ? "button-collapse" : "button-enlarge"} size={10} class="opacity-60" />
          </button>
          <Show when={open()}>
            <WorkLog steps={steps()} now={now()} asked="收到" class="mt-1.5" />
          </Show>
        </div>
      )}
    </Show>
  );
}

/** A session's steps by round, each round folded to its answer but the last. */
export function WorkLog(props: { steps: SessionEvent[]; now: number; asked?: string; working?: boolean; class?: string }) {
  const shown = () => shownEvents(props.steps);
  const rounds = () => roundsOf(shown());
  const firstAsked = () => shown().find((s) => s.type === "user/message" && s.under === undefined)?.seq;
  return (
    <div class={["max-h-[352px] divide-y divide-line overflow-y-auto rounded-md border border-line bg-page", props.class]} aria-label="干活过程">
      <For each={rounds()} keyed={(r) => r.asked?.seq ?? -1}>
        {(r, i) => (
          <RoundView
            round={r()}
            last={i() === rounds().length - 1}
            live={!!props.working && i() === rounds().length - 1}
            now={props.now}
            label={roundLabel(r(), firstAsked(), props.asked)}
          />
        )}
      </For>
    </div>
  );
}

function RoundView(props: { round: Round; last: boolean; live: boolean; now: number; label: string }) {
  const [toggled, setToggled] = createSignal<boolean>();
  const open = () => toggled() ?? props.last;
  const end = () => (props.live ? props.now : (lastTime(props.round) ?? props.now));
  const shown = () => {
    const answer = answerOf(props.round);
    return open() ? props.round.steps : answer ? [answer] : [];
  };
  return (
    <div class="flex flex-col gap-1.5 px-2 pt-2 pb-2.5">
      <button
        type="button"
        onClick={() => setToggled(!open())}
        aria-label={open() ? "收起这一轮" : "展开这一轮"}
        class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover"
      >
        <Icon name="button-next" size={12} class={["transition-transform duration-150", { "rotate-90": open() }]} />
        <span class="text-sm font-semibold">{props.label}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-muted">
          {props.round.steps.length} 步 · {tookText(roundMs(props.round, end()))}
          {props.live ? " · 进行中" : ""}
        </span>
        <Show when={props.round.asked}>{(asked) => <When at={asked().time} now={props.now} />}</Show>
      </button>
      <Show when={props.round.asked}>
        {(asked) => (
          <div class="rounded-md bg-[#e5a93c24] px-3 py-2">
            <Folded text={asked().text} lines={4} />
          </div>
        )}
      </Show>
      <Show when={props.round.steps.length > 0}>
        <TimeBar round={props.round} end={end()} />
      </Show>
      <For each={shown()} keyed={(s) => s.seq}>
        {(s) => (
          <div class={s().under !== undefined ? "ml-5 border-l-2 border-[#74a04680] pl-2.5" : ""}>
            <Step step={s()} now={props.now} />
          </div>
        )}
      </For>
      <Show when={!open() && props.round.steps.length > shown().length}>
        <button type="button" onClick={() => setToggled(true)} class="cursor-pointer self-start pl-1.5 text-sm text-water hover:underline">
          看这一轮的 {props.round.steps.length} 步
        </button>
      </Show>
    </div>
  );
}

function TimeBar(props: { round: Round; end: number }) {
  const spans = () => spansOf(props.round, props.end);
  // The shortest span still shows: at least 1/80 of the bar.
  const least = () => {
    const total = spans().reduce((n, s) => n + s.ms, 0);
    return total <= 0 ? 1 : total / 80;
  };
  return (
    <div class="flex h-2 gap-px overflow-hidden rounded-[3px]">
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
  return <span class="shrink-0 text-xs text-faint">{ago(props.at, props.now)}</span>;
}

function Folded(props: { text: string; lines: number; markdown?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const long = () => isLongText(props.text, props.lines);
  const clamp = () => long() && !open();
  return (
    <div class="flex flex-col items-start">
      <div
        class={["w-full overflow-hidden", { "text-base whitespace-pre-wrap": !props.markdown }]}
        style={clamp() ? { "max-height": `${props.lines * 22}px` } : undefined}
      >
        {props.markdown ? <Markdown text={props.text} /> : props.text}
      </div>
      <Show when={long()}>
        <button type="button" onClick={() => setOpen(!open())} class="mt-1 cursor-pointer text-sm text-water hover:underline">
          {open() ? "收起" : "展开全部"}
        </button>
      </Show>
    </div>
  );
}

function Box(props: { fill?: string; edge?: boolean; faint?: boolean; label: string; step: SessionEvent; now: number; children: JSX.Element }) {
  return (
    <div
      class={["rounded-md px-3 py-2", { "border border-line": !!props.edge, "opacity-80": !!props.faint }]}
      style={props.fill ? { background: props.fill } : undefined}
    >
      <div class="mb-1 flex items-center">
        <span class="text-xs font-semibold text-muted">{props.label}</span>
        <span class="flex-1" />
        <When at={props.step.time} now={props.now} />
      </div>
      {props.children}
    </div>
  );
}

function Line(props: { mark: string; step: SessionEvent; now: number; fill: string; ink: string }) {
  return (
    <div class="flex items-start gap-2 rounded-md px-3 py-1.5" style={{ background: props.fill }}>
      <Icon name={props.mark} size={12} class="mt-1" />
      <span class={["min-w-0 flex-1 text-sm", props.ink]}>{props.step.text}</span>
      <When at={props.step.time} now={props.now} />
    </div>
  );
}

function Step(props: { step: SessionEvent; now: number }) {
  const sub = () => props.step.under !== undefined;
  // Not rows: a run's bounds split the rounds, a result is shown in its call (shownEvents).
  return (
    <Switch>
      <Match when={props.step.type === "user/message"}>
        <Box fill="#e5a93c24" label={sub() ? "帮手接到" : "带话"} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={4} />
        </Box>
      </Match>
      <Match when={props.step.type === "memory/recalled"}>
        <Box fill="#b4cb7c26" label="想起了" step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={3} />
        </Box>
      </Match>
      <Match when={props.step.type === "assistant/thinking"}>
        <Box edge faint label={sub() ? "帮手想了想" : "想了想"} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={2} />
        </Box>
      </Match>
      <Match when={props.step.type === "assistant/message"}>
        <Box fill="#2f1f130f" label={sub() ? "帮手说" : "它说"} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={8} markdown />
        </Box>
      </Match>
      <Match when={props.step.type === "tool/call"}>
        <ToolStep step={props.step} now={props.now} />
      </Match>
      <Match when={props.step.type === "llm/retry"}>
        <Line mark="button-replay" step={props.step} now={props.now} fill="#e5a93c1f" ink="text-ink" />
      </Match>
      <Match when={props.step.type === "llm/usage"}>
        <Line mark="icon-coin" step={props.step} now={props.now} fill="#e5a93c0f" ink="text-muted" />
      </Match>
      <Match when={props.step.type === "run/error"}>
        <Line mark="mark-warn" step={props.step} now={props.now} fill="#c84a3a1a" ink="text-berry" />
      </Match>
    </Switch>
  );
}

function ToolStep(props: { step: SessionEvent; now: number }) {
  const [open, setOpen] = createSignal(false);
  const farm = () => farmToolText(props.step.text);
  const kind = () => (farm() ? "田头" : (props.step.actionText ?? ""));
  const input = () => readableInput(props.step);
  const state = () => (props.step.ok === undefined ? "进行中" : props.step.ok ? "成功" : "失败");
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open())}
        aria-expanded={aria(open())}
        class={["flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-hover", { "bg-hover": open() }]}
      >
        <Icon name={`act-${props.step.action ?? "other"}`} size={16} />
        <span class="w-16 shrink-0 truncate text-sm font-medium">{kind()}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted">{farm() ?? props.step.text}</span>
        <span title={state()} class="shrink-0">
          <Show when={props.step.ok !== undefined} fallback={<span class="text-xs text-faint">…</span>}>
            <Icon name={props.step.ok ? "mark-check" : "mark-cross"} size={12} label={state()} />
          </Show>
        </span>
        <When at={props.step.time} now={props.now} />
      </button>
      <Show when={open()}>
        <div class="flex flex-col gap-1.5 pt-1 pr-2 pb-2 pl-8">
          {props.step.tool && <span class="text-xs text-muted">工具 {props.step.tool}</span>}
          <Show when={input()}>
            {(text) => <pre class="max-h-40 overflow-auto rounded-md bg-ink px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-[#eedcb2]">{text()}</pre>}
          </Show>
          <Show when={props.step.output} fallback={<span class="text-xs text-muted">{props.step.ok === undefined ? "还没返回" : "没有输出"}</span>}>
            {(out) => <pre class="max-h-56 overflow-auto rounded-md bg-hover px-2.5 py-2 font-mono text-xs whitespace-pre-wrap">{out()}</pre>}
          </Show>
        </div>
      </Show>
    </div>
  );
}
