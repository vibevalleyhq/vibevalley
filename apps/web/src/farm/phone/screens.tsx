// The phone's screens other than the games: the home screen's apps, a call ringing, the
// missed calls and the log, and the manager's line. The web has no voice yet, so calling the manager says so and points
// to 田头 instead of dialing.

import type { ReactNode } from "react";
import type { InboxItem } from "@vibevalley/protocol";
import { useAgents } from "../../data/agents";
import { callerName } from "../../rules/notice";
import { AgentFace, ManagerFace } from "../../ui/Face";
import { cx, type GlyphCell, SpriteIcon } from "../kit";
import { inboxKindLabel, missedOf, usePhone } from "./calls";
import { BugSnakeIcon } from "./games/BugSnakeGame";
import { MergeIcon } from "./games/MergeGame";
import { lcd } from "./lcd";
import { phoneCells } from "./PhoneButton";

export type PhoneApp = "home" | "missed" | "log" | "manager" | "blocks" | "dino" | "sokoban" | "bugs" | "merge";

const cream = "#f7e8c4";
const bark = "#2f1f13";
const answerGreen = "#5a8234";
const declineRed = "#c84a3a";

/** Cells on a grid, scaled whole into `size` and centred. */
export function Cells({
  cells,
  grid,
  size,
  origin = [0, 0],
}: {
  cells: readonly GlyphCell[];
  grid: [number, number];
  size: [number, number];
  origin?: [number, number];
}) {
  return (
    <svg
      width={size[0]}
      height={size[1]}
      viewBox={`${origin[0]} ${origin[1]} ${grid[0]} ${grid[1]}`}
      shapeRendering="crispEdges"
      aria-hidden
      className="shrink-0"
    >
      {cells.map(([x, y, w, h, fill], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={fill} />
      ))}
    </svg>
  );
}

export const PhoneGlyph = ({ size, lit = false }: { size: number; lit?: boolean }) => (
  <Cells cells={phoneCells(lit)} grid={[10, 16]} size={[(size * 10) / 16, size]} />
);

function CallerFace({ call, size }: { call: InboxItem; size: number }) {
  const agents = useAgents().data ?? [];
  if (call.from.kind === "manager") return <ManagerFace size={size} />;
  const { agent, id } = call.from;
  return <AgentFace agentId={agent || id} look={agents.find((a) => a.id === agent)?.look} size={size} />;
}

const BigFace = ({ children, shake = false }: { children: ReactNode; shake?: boolean }) => (
  <span
    className={cx("grid size-[72px] place-items-center", shake && "phone-shake")}
    style={{ background: lcd.pale, boxShadow: `inset 0 0 0 2px ${lcd.dark}` }}
  >
    {children}
  </span>
);

const SmallFace = ({ children }: { children: ReactNode }) => (
  <span className="grid size-8 shrink-0 place-items-center overflow-hidden" style={{ background: lcd.pale }}>
    {children}
  </span>
);

export function RingingScreen({ call, onAnswer, onDecline }: { call: InboxItem; onAnswer: () => void; onDecline: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center px-3 pt-5 text-center">
      <span className="phone-blink">来电…</span>
      <span className="mt-3">
        <BigFace shake>
          <CallerFace call={call} size={60} />
        </BigFace>
      </span>
      <p className="mt-3 text-[24px] leading-none">{callerName(call)}</p>
      <p className="mt-2 px-2" style={{ background: lcd.dark, color: lcd.pale }}>
        {inboxKindLabel[call.kind]}
      </p>
      <p className="mt-2 line-clamp-3 leading-[1.625]">{call.text}</p>
      <div className="mt-auto mb-5 flex gap-8">
        <RoundKey answer={false} label="挂断" onClick={onDecline} />
        <RoundKey answer label="接听" onClick={onAnswer} />
      </div>
    </div>
  );
}

function RoundKey({ answer, label, onClick }: { answer: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex cursor-pointer flex-col items-center gap-1">
      <span
        className="grid size-11 place-items-center"
        style={{
          background: answer ? answerGreen : declineRed,
          boxShadow: `inset 0 0 0 2px ${bark}, inset -3px -3px 0 0 #00000040`,
        }}
      >
        <span style={answer ? undefined : { transform: "rotate(135deg)" }} className="flex">
          <Cells
            cells={[
              [0, 2, 3, 4, cream],
              [8, 2, 3, 4, cream],
              [1, 0, 9, 2, cream],
            ]}
            grid={[11, 6]}
            size={[22, 12]}
          />
        </span>
      </span>
      {label}
    </button>
  );
}

function CallManager({ onCall }: { onCall: () => void }) {
  return (
    <button
      type="button"
      onClick={onCall}
      className="m-2 flex cursor-pointer items-center justify-center gap-2 py-1.5 hover:brightness-110"
      style={{ background: answerGreen, color: cream, boxShadow: `inset 0 0 0 2px ${bark}` }}
    >
      <PhoneGlyph size={14} lit />
      打给管家
    </button>
  );
}

export function ListScreen({
  screen,
  onScreen,
  onAnswer,
  onCall,
}: {
  screen: "missed" | "log";
  onScreen: (s: "missed" | "log") => void;
  onAnswer: (c: InboxItem) => void;
  onCall: () => void;
}) {
  const phone = usePhone();
  const missed = missedOf(phone);
  const empty = (text: string) => (
    <li className="px-3 py-6 text-center" style={{ color: lcd.dark }}>
      {text}
    </li>
  );
  const row = "flex w-full items-center gap-2 px-2 py-1.5 text-left";
  const rule = { borderBottom: `1px solid ${lcd.rule}` };
  return (
    <>
      <div className="flex" style={{ borderBottom: `2px solid ${lcd.dark}` }}>
        {(["missed", "log"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onScreen(s)}
            aria-pressed={screen === s}
            className={cx("flex-1 cursor-pointer py-1", screen !== s && "hover:bg-[#b9cf8c]")}
            style={screen === s ? { background: lcd.dark, color: lcd.pale } : undefined}
          >
            {s === "missed" ? `未接 ${missed.length}` : "记录"}
          </button>
        ))}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {screen === "missed"
          ? missed.length === 0
            ? empty("没有未接来电。地里都好好的。")
            : missed.map((c) => (
                <li key={c.id} style={rule}>
                  <button
                    type="button"
                    onClick={() => onAnswer(c)}
                    aria-label={`${callerName(c)}：${inboxKindLabel[c.kind]}`}
                    className={cx(row, "cursor-pointer hover:bg-[#b9cf8c]")}
                  >
                    <SmallFace>
                      <CallerFace call={c} size={28} />
                    </SmallFace>
                    <span className="min-w-0 flex-1">
                      <span className="flex">
                        {callerName(c)}
                        <span className="ml-auto" style={{ color: declineRed }}>
                          {inboxKindLabel[c.kind]}
                        </span>
                      </span>
                      <span className="block truncate" style={{ color: lcd.dark }}>
                        {c.text}
                      </span>
                    </span>
                  </button>
                </li>
              ))
          : phone.log.length === 0
            ? empty("还没有通话。")
            : phone.log.map((e) => (
                <li key={`${e.call.id}-${e.at}`} className={row} style={rule}>
                  <SmallFace>
                    <CallerFace call={e.call} size={28} />
                  </SmallFace>
                  <span className="min-w-0 flex-1 truncate">
                    {callerName(e.call)} · {inboxKindLabel[e.call.kind]}
                  </span>
                  <span style={{ color: e.answered ? lcd.dark : declineRed }}>{e.answered ? "接了" : "挂了"}</span>
                </li>
              ))}
      </ul>
      <CallManager onCall={onCall} />
    </>
  );
}

/** The manager's line: on the web it cannot be dialed yet, so it sends you to 田头. */
export function ManagerScreen({ onChat }: { onChat: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center px-3 pt-5 text-center">
      <BigFace>
        <ManagerFace size={60} />
      </BigFace>
      <p className="mt-2 text-[24px] leading-none">管家</p>
      <p className="mt-3 leading-[1.625]">网页上还打不了电话。</p>
      <p className="leading-[1.625]" style={{ color: lcd.dark }}>
        有事去田头跟他说，他一样听得到。
      </p>
      <button
        type="button"
        onClick={onChat}
        className="mt-auto mb-5 cursor-pointer px-3 py-1.5 hover:brightness-110"
        style={{ background: answerGreen, color: cream, boxShadow: `inset 0 0 0 2px ${bark}` }}
      >
        去田头说
      </button>
    </div>
  );
}

export function HomeScreen({
  missed,
  onOpen,
  onChannels,
  onTaskBoard,
}: {
  missed: number;
  onOpen: (app: PhoneApp) => void;
  onChannels: () => void;
  onTaskBoard: () => void;
}) {
  const apps: { label: string; icon: ReactNode; badge?: number; go: () => void }[] = [
    { label: "未接", icon: <PhoneGlyph size={26} lit={missed > 0} />, badge: missed, go: () => onOpen("missed") },
    { label: "记录", icon: <SpriteIcon name="icon-log" size={28} />, go: () => onOpen("log") },
    { label: "管家", icon: <ManagerFace size={28} />, go: () => onOpen("manager") },
    { label: "频道", icon: <SpriteIcon name="icon-board" size={28} />, go: onChannels },
    { label: "计划", icon: <SpriteIcon name="icon-task-board" size={28} />, go: onTaskBoard },
    { label: "方块", icon: <BlocksIcon />, go: () => onOpen("blocks") },
    {
      label: "推箱子",
      icon: (
        <span className="grid size-7 place-items-center text-[18px] leading-none" style={{ boxShadow: `inset 0 0 0 2px ${lcd.ink}` }}>
          ×
        </span>
      ),
      go: () => onOpen("sokoban"),
    },
    { label: "小恐龙", icon: <DinoIcon />, go: () => onOpen("dino") },
    { label: "贪吃虫", icon: <BugSnakeIcon />, go: () => onOpen("bugs") },
    { label: "种田 2048", icon: <MergeIcon />, go: () => onOpen("merge") },
  ];
  return (
    <div className="grid grid-cols-3 content-start gap-y-3 px-2 pt-4">
      {apps.map((a) => (
        <button key={a.label} type="button" onClick={a.go} aria-label={a.label} className="group flex cursor-pointer flex-col items-center gap-1">
          <span
            className="relative grid size-11 place-items-center bg-[#e8f0c8] group-hover:bg-[#f2f7dc] group-active:translate-y-px"
            style={{ boxShadow: `inset 0 0 0 2px ${lcd.dark}` }}
          >
            {a.icon}
            {a.badge ? (
              <span className="absolute -top-1.5 -right-1.5 px-1 leading-[14px]" style={{ background: declineRed, color: cream }}>
                {a.badge}
              </span>
            ) : null}
          </span>
          {a.label}
        </button>
      ))}
    </div>
  );
}

function BlocksIcon() {
  return (
    <Cells
      cells={[
        [0, 5, 7, 2, lcd.dark],
        [1, 4, 2, 1, lcd.dark],
        [2, 1, 3, 1, lcd.ink],
        [3, 2, 1, 1, lcd.ink],
        [5, 4, 1, 1, lcd.mid],
        [4, 5, 1, 1, lcd.paper],
      ]}
      grid={[7, 7]}
      size={[28, 28]}
    />
  );
}

const dinoRows = ["  ####", " ## ##", " #####", " ##   ", "####  ", "##### ", " ###  ", " # #  "];
const dinoCells: GlyphCell[] = [
  ...dinoRows.flatMap((row, y) => [...row].flatMap((c, x): GlyphCell[] => (c === "#" ? [[x, y, 1, 1, lcd.ink]] : []))),
  [-1, 8, 8, 1, lcd.dark],
];

const DinoIcon = () => <Cells cells={dinoCells} grid={[8, 10]} size={[28, 28]} origin={[-1, -1]} />;
