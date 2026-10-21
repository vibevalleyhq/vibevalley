import { type ReactNode, useState } from "react";
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
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { useSessionEvents } from "./data";

/** Under a report or the manager's answer: the run behind it, folded to one line until opened. */
export function TurnSteps({ session, run, manager = false }: { session: string; run: string | undefined; manager?: boolean }) {
  const [open, setOpen] = useState(false);
  const steps = useSessionEvents(session, !!run).filter((e) => e.run === run);
  const label = run ? turnLabel(steps, manager) : undefined;
  if (!label) return null;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted hover:bg-hover"
      >
        <Icon name="icon-log" size={14} />
        {label}
        <Icon name={open ? "button-collapse" : "button-enlarge"} size={10} className="opacity-60" />
      </button>
      {open && <WorkLog steps={steps} now={Date.now()} asked="收到" className="mt-1.5" />}
    </div>
  );
}

/** A session's steps by round, each round folded to its answer but the last. */
export function WorkLog({
  steps,
  now,
  asked,
  working = false,
  className = "",
}: {
  steps: SessionEvent[];
  now: number;
  asked?: string;
  working?: boolean;
  className?: string;
}) {
  const shown = shownEvents(steps);
  const rounds = roundsOf(shown);
  const firstAsked = shown.find((s) => s.type === "user/message" && s.under === undefined)?.seq;
  return (
    <div className={`max-h-[352px] divide-y divide-line overflow-y-auto rounded-md border border-line bg-page ${className}`} aria-label="干活过程">
      {rounds.map((r, i) => (
        <RoundView
          key={r.asked?.seq ?? -1}
          round={r}
          last={i === rounds.length - 1}
          live={working && i === rounds.length - 1}
          now={now}
          label={roundLabel(r, firstAsked, asked)}
        />
      ))}
    </div>
  );
}

function RoundView({ round, last, live, now, label }: { round: Round; last: boolean; live: boolean; now: number; label: string }) {
  const [toggled, setToggled] = useState<boolean>();
  const open = toggled ?? last;
  const end = live ? now : (lastTime(round) ?? now);
  const answer = answerOf(round);
  const shown = open ? round.steps : answer ? [answer] : [];
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-2 pb-2.5">
      <button
        type="button"
        onClick={() => setToggled(!open)}
        aria-label={open ? "收起这一轮" : "展开这一轮"}
        className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover"
      >
        <Icon name="button-next" size={12} className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        <span className="text-sm font-semibold">{label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {round.steps.length} 步 · {tookText(roundMs(round, end))}
          {live ? " · 进行中" : ""}
        </span>
        {round.asked && <When at={round.asked.time} now={now} />}
      </button>
      {round.asked && (
        <div className="rounded-md bg-[#e5a93c24] px-3 py-2">
          <Folded text={round.asked.text} lines={4} />
        </div>
      )}
      {round.steps.length > 0 && <TimeBar round={round} end={end} />}
      {shown.map((s) => (
        <div key={s.seq} className={s.under !== undefined ? "ml-5 border-l-2 border-[#74a04680] pl-2.5" : ""}>
          <Step step={s} now={now} />
        </div>
      ))}
      {!open && round.steps.length > shown.length && (
        <button type="button" onClick={() => setToggled(true)} className="cursor-pointer self-start pl-1.5 text-sm text-water hover:underline">
          看这一轮的 {round.steps.length} 步
        </button>
      )}
    </div>
  );
}

function TimeBar({ round, end }: { round: Round; end: number }) {
  const spans = spansOf(round, end);
  const total = spans.reduce((n, s) => n + s.ms, 0);
  // The shortest span still shows: at least 1/80 of the bar.
  const least = total <= 0 ? 1 : total / 80;
  return (
    <div className="flex h-2 gap-px overflow-hidden rounded-[3px]">
      {spans.map((s) => (
        <span
          key={s.step.seq}
          title={`${spanLabel(s.step)} · ${tookText(s.ms)}\n${s.step.text.split("\n")[0]}`}
          className="hover:!bg-ink"
          style={{ flexGrow: Math.max(1, Math.round((Math.max(s.ms, least) / least) * 10)), background: spanColor(s.step) }}
        />
      ))}
    </div>
  );
}

const When = ({ at, now }: { at: number; now: number }) => <span className="shrink-0 text-xs text-faint">{ago(at, now)}</span>;

function Folded({ text, lines, markdown = false }: { text: string; lines: number; markdown?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = isLongText(text, lines);
  const clamp = long && !open;
  return (
    <div className="flex flex-col items-start">
      <div className={`w-full overflow-hidden ${markdown ? "" : "text-base whitespace-pre-wrap"}`} style={clamp ? { maxHeight: lines * 22 } : undefined}>
        {markdown ? <Markdown text={text} /> : text}
      </div>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 cursor-pointer text-sm text-water hover:underline">
          {open ? "收起" : "展开全部"}
        </button>
      )}
    </div>
  );
}

function Box({
  fill,
  edge,
  faint,
  label,
  step,
  now,
  children,
}: {
  fill?: string;
  edge?: boolean;
  faint?: boolean;
  label: string;
  step: SessionEvent;
  now: number;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-md px-3 py-2 ${edge ? "border border-line" : ""} ${faint ? "opacity-80" : ""}`} style={fill ? { background: fill } : undefined}>
      <div className="mb-1 flex items-center">
        <span className="text-xs font-semibold text-muted">{label}</span>
        <span className="flex-1" />
        <When at={step.time} now={now} />
      </div>
      {children}
    </div>
  );
}

function Line({ mark, step, now, fill, ink }: { mark: string; step: SessionEvent; now: number; fill: string; ink: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md px-3 py-1.5" style={{ background: fill }}>
      <Icon name={mark} size={12} className="mt-1" />
      <span className={`min-w-0 flex-1 text-sm ${ink}`}>{step.text}</span>
      <When at={step.time} now={now} />
    </div>
  );
}

function Step({ step, now }: { step: SessionEvent; now: number }) {
  const sub = step.under !== undefined;
  switch (step.type) {
    case "user/message":
      return (
        <Box fill="#e5a93c24" label={sub ? "帮手接到" : "带话"} step={step} now={now}>
          <Folded text={step.text} lines={4} />
        </Box>
      );
    case "memory/recalled":
      return (
        <Box fill="#b4cb7c26" label="想起了" step={step} now={now}>
          <Folded text={step.text} lines={3} />
        </Box>
      );
    case "assistant/thinking":
      return (
        <Box edge faint label={sub ? "帮手想了想" : "想了想"} step={step} now={now}>
          <Folded text={step.text} lines={2} />
        </Box>
      );
    case "assistant/message":
      return (
        <Box fill="#2f1f130f" label={sub ? "帮手说" : "它说"} step={step} now={now}>
          <Folded text={step.text} lines={8} markdown />
        </Box>
      );
    case "tool/call":
      return <ToolStep step={step} now={now} />;
    case "llm/retry":
      return <Line mark="button-replay" step={step} now={now} fill="#e5a93c1f" ink="text-ink" />;
    case "llm/usage":
      return <Line mark="icon-coin" step={step} now={now} fill="#e5a93c0f" ink="text-muted" />;
    case "run/error":
      return <Line mark="mark-warn" step={step} now={now} fill="#c84a3a1a" ink="text-berry" />;
    // Not rows: a run's bounds split the rounds, a result is shown in its call (shownEvents).
    case "run/start":
    case "run/end":
    case "tool/result":
      return null;
  }
}

function ToolStep({ step, now }: { step: SessionEvent; now: number }) {
  const [open, setOpen] = useState(false);
  const farm = farmToolText(step.text);
  const kind = farm ? "田头" : (step.actionText ?? "");
  const input = readableInput(step);
  const state = step.ok === undefined ? "进行中" : step.ok ? "成功" : "失败";
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-hover ${open ? "bg-hover" : ""}`}
      >
        <Icon name={`act-${step.action ?? "other"}`} size={16} />
        <span className="w-16 shrink-0 truncate text-sm font-medium">{kind}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{farm ?? step.text}</span>
        <span title={state} className="shrink-0">
          {step.ok === undefined ? (
            <span className="text-xs text-faint">…</span>
          ) : (
            <Icon name={step.ok ? "mark-check" : "mark-cross"} size={12} label={state} />
          )}
        </span>
        <When at={step.time} now={now} />
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 pt-1 pr-2 pb-2 pl-8">
          {step.tool && <span className="text-xs text-muted">工具 {step.tool}</span>}
          {input && <pre className="max-h-40 overflow-auto rounded-md bg-ink px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-[#eedcb2]">{input}</pre>}
          {step.output ? (
            <pre className="max-h-56 overflow-auto rounded-md bg-hover px-2.5 py-2 font-mono text-xs whitespace-pre-wrap">{step.output}</pre>
          ) : (
            <span className="text-xs text-muted">{step.ok === undefined ? "还没返回" : "没有输出"}</span>
          )}
        </div>
      )}
    </div>
  );
}
