// A trajectory a row per step: the round in the gutter, what kind of step in
// the tag, its text cut to a line until the row is opened; a waterfall of the rounds over it and their totals under it.
// The manager's lets a round be marked wrong, which saves it as a case of its evals.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ManagerEval, SessionEvent } from "@vibevalley/protocol";
import { useQuery } from "@tanstack/react-query";
import { api, reasonOf } from "../data/api";
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
} from "../rules/rounds";
import { ago } from "../rules/time";
import { TextInput } from "../ui/Field";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { useToast } from "../ui/Toast";
import { useSessionEvents } from "./chat/data";
import { Quiet } from "./kit";

/** Saves the round its user/message `step` began as a case of the manager's evals; `want` is what it should have done. */
export type MarkWrong = (step: number, want: string) => Promise<ManagerEval>;

const laneNames: Record<Lane, string> = { asked: "收到", model: "模型", tool: "工具" };

const tagFill = (step: SessionEvent) => (step.type === "llm/usage" ? "#2f1f131a" : step.type === "llm/retry" ? "#f1dcab" : spanColor(step));

/** A dark fill takes light words. */
function inkOn(fill: string) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fill);
  if (!m) return "#2f1f13";
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255) as [number, number, number];
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) < 0.25 ? "#fffaf0" : "#2f1f13";
}

const haystack = (step: SessionEvent, tag: string) => [tag, step.text, step.tool ?? "", step.input ?? "", step.output ?? ""].join("\n").toLowerCase();

function summaryText(s: TrajectorySummary) {
  const hit = cacheHit(s);
  return [
    `${s.rounds} 轮`,
    `${s.steps} 步`,
    `模型用时 ${secondsText(s.modelMs)}`,
    `工具用时 ${secondsText(s.toolMs)}`,
    ...(hit !== undefined ? [`缓存命中 ${Math.round(hit * 100)}%`, `输入 ${tokensText(s.input + s.cacheRead)} / 输出 ${tokensText(s.output)} token`] : []),
  ].join(" · ");
}

/** A session's (or the manager's) trajectory, read and then followed live. */
export function TrajectoryLog({
  id,
  asked,
  empty = "还没有动静。",
  onMarkWrong,
  title,
  about,
}: {
  id: string;
  asked?: string;
  empty?: string;
  onMarkWrong?: MarkWrong;
  title?: string;
  about?: string;
}) {
  const steps = useSessionEvents(id, true);
  const head = title ? (
    <span className="truncate text-sm font-semibold" title={about}>
      {title}
    </span>
  ) : undefined;
  if (steps.length === 0)
    return (
      <div className="flex flex-col gap-2">
        {head}
        <Quiet>{empty}</Quiet>
      </div>
    );
  return <Trajectory steps={steps} now={Date.now()} asked={asked} onMarkWrong={onMarkWrong} head={head} />;
}

export function Trajectory({
  steps,
  now,
  asked,
  working = false,
  onMarkWrong,
  head,
}: {
  steps: SessionEvent[];
  now: number;
  asked?: string;
  working?: boolean;
  onMarkWrong?: MarkWrong;
  head?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [marked, setMarked] = useState<number>();
  // The rounds marked wrong here, by their asked step: the case's file.
  const [wrong, setWrong] = useState<ReadonlyMap<number, string>>(new Map());
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const rowsRef = useRef(new Map<number, HTMLElement>());

  // Stuck to the newest unless scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [steps]);

  const shown = shownEvents(steps);
  const rounds = roundsOf(shown);
  const last = steps.at(-1)?.time ?? now;
  const end = working && now > last ? now : last;
  const firstAsked = shown.find((s) => s.type === "user/message" && s.under === undefined)?.seq;
  const bySeq = new Map(shown.map((s) => [s.seq, s]));
  const q = query.trim().toLowerCase();
  const show = (seq: number) => {
    setQuery("");
    setMarked(seq);
    atBottom.current = false;
    requestAnimationFrame(() => rowsRef.current.get(seq)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };

  const rows: React.ReactNode[] = [];
  let turn = 0;
  for (const round of rounds) {
    if (round.asked) turn++;
    let first = true;
    for (const step of round.asked ? [round.asked, ...round.steps] : round.steps) {
      const tag = tagOf(step, asked, step.seq === firstAsked);
      if (q && !haystack(step, tag).includes(q)) continue;
      const n = step.seq;
      const row = (
        <Row
          key={n}
          step={step}
          tag={tag}
          gutter={first ? (round.asked ? `第 ${turn} 轮` : "更早") : undefined}
          when={first ? ago((round.asked ?? round.steps[0]!).time, now) : undefined}
          open={open.has(n)}
          marked={marked === n}
          refTo={(el) => (el ? rowsRef.current.set(n, el) : rowsRef.current.delete(n))}
          onToggle={() => setOpen((o) => (o.has(n) ? new Set([...o].filter((x) => x !== n)) : new Set([...o, n])))}
        />
      );
      rows.push(
        onMarkWrong && step.type === "user/message" && step.under === undefined ? (
          <Markable key={n} step={n} send={onMarkWrong} file={wrong.get(n)} onMarked={(file) => setWrong(new Map([...wrong, [n, file]]))}>
            {row}
          </Markable>
        ) : (
          row
        ),
      );
      first = false;
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 pb-2">
        <div className="min-w-0 flex-1">{head}</div>
        <TextInput aria-label="搜索轨迹" placeholder="搜索" className="w-36 sm:w-56" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <WaterfallView steps={steps} end={end} colorOf={(seq) => (bySeq.get(seq) ? spanColor(bySeq.get(seq)!) : "#9b7550")} onPick={show} />
      <div
        ref={scroller}
        className="mt-2 min-h-0 flex-1 overflow-y-auto border-y border-line py-1"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {rows.length === 0 ? <p className="pt-2 text-sm text-muted">没有对得上的步骤。</p> : rows}
      </div>
      <p className="pt-2 text-xs text-muted">{summaryText(summaryOf(steps, end))}</p>
    </div>
  );
}

const gutterW = "w-15";
const tagW = "w-22";

function Row({
  step,
  tag,
  gutter,
  when,
  open,
  marked,
  refTo,
  onToggle,
}: {
  step: SessionEvent;
  tag: string;
  gutter?: string;
  when?: string;
  open: boolean;
  marked: boolean;
  refTo: (el: HTMLElement | null) => void;
  onToggle: () => void;
}) {
  const fill = tagFill(step);
  const tool = step.type === "tool/call";
  const failed = (tool && step.ok === false) || step.type === "run/error";
  const sub = step.under !== undefined;
  let content: React.ReactNode;
  if (tool) content = <ToolLine step={step} />;
  else if (open && step.type === "assistant/message") content = <Markdown text={step.text} />;
  else if (open) content = <span className="whitespace-pre-wrap">{step.text}</span>;
  else content = <span className="block truncate">{oneLine(step.text)}</span>;
  return (
    <div ref={refTo} className={`rounded-md py-[3px] pr-2 ${marked ? "bg-wheat/35" : "hover:bg-hover"}`}>
      <button
        type="button"
        aria-label={`${tag} ${oneLine(step.text)}`}
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-start text-left"
      >
        <span className={`${gutterW} shrink-0 truncate pt-0.5 pl-2 text-xs text-muted`}>{gutter}</span>
        <span
          className={`mt-px shrink-0 truncate rounded px-1 py-px text-center text-xs font-medium ${sub ? "ml-2.5 w-[78px]" : tagW}`}
          style={{ background: sub ? `${fill}8c` : fill, color: inkOn(fill) }}
        >
          {tag}
        </span>
        <span className="w-2 shrink-0" />
        {failed && tool && <Icon name="mark-cross" size={12} className="mt-1 mr-1" />}
        <span className={`min-w-0 flex-1 text-sm ${failed ? "text-berry" : ""}`}>{content}</span>
        {when && <span className="shrink-0 pt-0.5 pl-2 text-xs text-faint">{when}</span>}
      </button>
      {open && tool && <ToolDetail step={step} />}
    </div>
  );
}

/** `what {args} → result`, the args and result in the code font. */
function ToolLine({ step }: { step: SessionEvent }) {
  const args = oneLine(step.input ?? "");
  const out = oneLine(step.output ?? "");
  return (
    <span className="block truncate">
      {farmToolText(step.text) ?? step.text}
      {args && <span className="font-mono text-muted"> {args}</span>}
      {" → "}
      {step.ok === undefined ? "还没返回" : !out ? "没有输出" : <span className={`font-mono ${step.ok === false ? "text-berry" : ""}`}>{out}</span>}
    </span>
  );
}

function ToolDetail({ step }: { step: SessionEvent }) {
  const input = readableInput(step);
  return (
    <div className="flex flex-col gap-1 pt-1 pb-1.5 pl-[164px] text-xs">
      <span className="text-muted">
        {[...(step.tool ? [`工具 ${step.tool}`] : []), step.ok === undefined ? "进行中" : step.ok ? "成功" : "失败"].join(" · ")}
      </span>
      {input && (
        <>
          <span className="text-muted">输入</span>
          <pre className="font-mono whitespace-pre-wrap select-text">{input}</pre>
        </>
      )}
      <span className="text-muted">输出</span>
      {step.output ? (
        <pre className="font-mono whitespace-pre-wrap select-text">{step.output}</pre>
      ) : (
        <span className="text-muted">{step.ok === undefined ? "还没返回" : "没有输出"}</span>
      )}
    </div>
  );
}

/** Rounds side by side by how long each took; the idle time between them is a fixed gap. */
function WaterfallView({
  steps,
  end,
  colorOf,
  onPick,
}: {
  steps: SessionEvent[];
  end: number;
  colorOf: (seq: number) => string;
  onPick: (seq: number) => void;
}) {
  const fall = waterfallOf(steps, end);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const lane = 12;
  const gap = 2;
  const between = 4;
  const rounds = fall.rounds;
  const room = Math.max(0, width - between * (rounds.length - 1));
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
  return (
    <div className="flex" style={{ height: lane * 3 + gap * 2 }}>
      <div className={`${gutterW} flex shrink-0 flex-col justify-between pl-2`}>
        {lanes.map((l) => (
          <span key={l} className="text-[11px] leading-none text-muted">
            {laneNames[l]}
          </span>
        ))}
      </div>
      <div ref={box} className="relative min-w-0 flex-1 overflow-hidden">
        {[0, 1, 2].map((i) => (
          <div key={i} className="absolute inset-x-0 rounded-sm bg-hover" style={{ top: i * (lane + gap), height: lane }} />
        ))}
        {width > 0 &&
          rounds.length > 0 &&
          fall.spans.map((span, i) => {
            while (r + 1 < rounds.length && span.start >= rounds[r + 1]![0]) r++;
            while (r > 0 && span.start < rounds[r]![0]) r--;
            const left = at(r, span.start);
            const w = Math.max(2, at(r, span.end) - left);
            const label = `${laneNames[span.lane]} · ${secondsText(span.end - span.start)}`;
            return (
              <button
                key={i}
                type="button"
                title={label}
                aria-label={label}
                onClick={() => onPick(span.seq)}
                className="absolute cursor-pointer rounded-sm hover:!bg-ink"
                style={{
                  left,
                  width: w - 1,
                  top: lanes.indexOf(span.lane) * (lane + gap),
                  height: lane,
                  background: span.lane === "asked" ? "#e5a93c" : span.lane === "model" ? "#74a046" : colorOf(span.seq),
                }}
              />
            );
          })}
      </div>
    </div>
  );
}

/** 这一轮做错了 floats over what began the round. */
function Markable({
  step,
  send,
  file,
  onMarked,
  children,
}: {
  step: number;
  send: MarkWrong;
  file?: string;
  onMarked: (file: string) => void;
  children: React.ReactNode;
}) {
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [want, setWant] = useState("");
  const toast = useToast();
  const submit = async () => {
    const w = want.trim();
    if (!w || busy) return;
    setBusy(true);
    try {
      const got = await send(step, w);
      setWriting(false);
      onMarked(got.file);
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="group relative">
      {children}
      {!file && !writing && (
        <button
          type="button"
          onClick={() => setWriting(true)}
          className="absolute top-0 right-0 hidden cursor-pointer items-center gap-1 rounded-md border border-line bg-page px-2 py-0.5 text-xs font-medium group-focus-within:flex group-hover:flex hover:underline"
        >
          <Icon name="icon-bug" size={12} />
          这一轮做错了
        </button>
      )}
      {file && (
        <div title={file} className="my-0.5 mr-2 ml-[164px] flex items-center gap-1.5 rounded-md bg-berry/12 px-2 py-1 text-xs">
          <Icon name="icon-bug" size={12} />
          标成了做错的一轮，存成了一条评测
        </div>
      )}
      {writing && (
        <form
          className="my-1 mr-2 ml-[164px] flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <TextInput
            autoFocus
            aria-label="这一轮应该怎样"
            disabled={busy}
            placeholder="它应该怎样：比如「先问我是哪个项目，别直接派活」"
            value={want}
            onChange={(e) => setWant(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy || !want.trim()}
            className="h-7 shrink-0 cursor-pointer rounded-md bg-accent px-2.5 text-sm text-page disabled:opacity-50"
          >
            记下
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setWriting(false)}
            className="h-7 shrink-0 cursor-pointer rounded-md border border-line px-2.5 text-sm"
          >
            算了
          </button>
        </form>
      )}
    </div>
  );
}

/** The helpers an agent sent, a list to pick from beside the picked one's trajectory. */
export function TrajectoryList({ agent }: { agent: string }) {
  const heads = useQuery({ queryKey: ["sessions", agent], queryFn: () => api.session.list({ agent }) });
  const [picked, setPicked] = useState<string>();
  const now = Date.now();
  if (!heads.data) return <Quiet>{heads.error ? reasonOf(heads.error) : "在读……"}</Quiet>;
  if (heads.data.length === 0) return <Quiet>还没派出去过。</Quiet>;
  const open = heads.data.find((h) => h.id === (picked ?? heads.data[0]!.id));
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 md:flex-row">
      <ul aria-label="派出去的帮工" className="flex max-h-33 shrink-0 flex-col gap-0.5 overflow-y-auto md:max-h-none md:w-60">
        {heads.data.map((h) => {
          const ended = h.phase._tag === "closed" ? h.phase.at : undefined;
          return (
            <li key={h.id}>
              <button
                type="button"
                aria-current={h === open ? "true" : undefined}
                onClick={() => setPicked(h.id)}
                className={`flex w-full cursor-pointer flex-col rounded-md px-2.5 py-1.5 text-left ${h === open ? "bg-selected" : "hover:bg-hover"}`}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{h.name}</span>
                  {h.project && <span className="text-xs text-muted">{h.project}</span>}
                  {ended === undefined && <span className="rounded bg-hat px-1.5 text-xs text-bark-900">在场</span>}
                </span>
                <span className="text-xs text-muted">
                  {ended === undefined ? `${ago(h.hiredAt, now)}接活` : `${ago(h.hiredAt, now)}接活 · ${ago(ended, now)}走的`}
                </span>
                {h.brief && <span className="truncate text-xs">{oneLine(h.brief)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="min-h-0 min-w-0 flex-1">
        {open ? (
          <TrajectoryLog key={open.id} id={open.id} title={open.brief ? `${open.name} · ${oneLine(open.brief)}` : open.name} about={open.brief} />
        ) : (
          <Quiet>选一个帮工，看它的轨迹。</Quiet>
        )}
      </div>
    </div>
  );
}
