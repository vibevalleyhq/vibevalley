// 种田 2048 on the phone: the rules are merge.ts; here the pad, swipes and the drawing,
// each stage a 12×12 picture. The field is kept while the phone is away or a call comes in. Arrows (or a swipe on the
// field) slide, B takes one slide back, A starts, goes on after 丰收, and asks before starting over.

import { useRef, useState } from "react";
import { playSound } from "../../sound";
import { lcd } from "../lcd";
import { kept, usePad } from "../pad";
import { type Merge, type MergeDirection, mergeGoal, mergeSize, mergeStageName, mergeStages, mergeTop, newMerge, slideMerge, undoMerge } from "./merge";

const game = kept<Merge | null>(null);
const best = kept(0);

/** 12×12: `#` ink, `+` dark, `o` mid, `.` light. */
const pictures: readonly (readonly string[])[] = [
  // 种子
  [
    "            ",
    "            ",
    "            ",
    "            ",
    "            ",
    "     ##     ",
    "    #oo#    ",
    "    #o.#    ",
    "    #oo#    ",
    "     ##     ",
    " +o++++o++o ",
    "++++++++++++",
  ],
  // 芽
  [
    "            ",
    "            ",
    "            ",
    "            ",
    "  ##   ##   ",
    " #oo# #oo#  ",
    "  #oo#oo#   ",
    "   ##+##    ",
    "     +      ",
    "     +      ",
    " +o+++++o++ ",
    "++++++++++++",
  ],
  // 叶
  [
    "            ",
    "     #      ",
    "    #o#     ",
    "    #o#     ",
    "  ## + ##   ",
    " #oo#+#oo#  ",
    " #o.o+o.o#  ",
    "  ###+###   ",
    "     +      ",
    "     +      ",
    " +o+++++o++ ",
    "++++++++++++",
  ],
  // 花
  [
    "   ## ##    ",
    "  #..#..#   ",
    "   ##o##    ",
    "  #..#..#   ",
    "   ##+##    ",
    "  ## + ##   ",
    " #oo#+#oo#  ",
    "  ##o+o##   ",
    "     +      ",
    "     +      ",
    " +o+++++o++ ",
    "++++++++++++",
  ],
  // 麦子
  [
    "  .   .   . ",
    " #o# #o# #o#",
    " o#o o#o o#o",
    " #o# #o# #o#",
    " o#o o#o o#o",
    "  +   +   + ",
    "  +   +   + ",
    "  +   +   + ",
    "  +   +   + ",
    "  +   +   + ",
    " ++o++++o+++",
    "++++++++++++",
  ],
  // 胡萝卜
  [
    "  #  #  #   ",
    "   # # #    ",
    "    ###     ",
    "  #######   ",
    "  #ooooo#   ",
    "  #o+ooo#   ",
    "   #ooo+#   ",
    "   #oooo#   ",
    "    #o+#    ",
    "    #oo#    ",
    "     #o#    ",
    "     ##     ",
  ],
  // 麦捆
  [
    "  o. o. .o  ",
    " #o#o#o#o#  ",
    "  #o#o#o#   ",
    "   #+++#    ",
    "   #+++#    ",
    "   #####    ",
    "   #...#    ",
    "   #+++#    ",
    "  #+++++#   ",
    " #+++++++#  ",
    " #+#+#+#+#  ",
    "            ",
  ],
  // 一筐
  [
    "            ",
    "    ####    ",
    "   #    #   ",
    "  # .oo. #  ",
    " #oo.oo.oo# ",
    "############",
    " #+.+.+.+.# ",
    " #.+.+.+.+# ",
    "  #+.+.+.#  ",
    "  ########  ",
    "            ",
    "            ",
  ],
  // 一车
  [
    "            ",
    "  o.oo.o    ",
    " #oooooo#   ",
    "##########  ",
    "#++++++++###",
    "#++++++++#  ",
    "##########  ",
    " ##    ##   ",
    "#..#  #..#  ",
    "#..#  #..#  ",
    " ##    ##   ",
    "            ",
  ],
  // 粮仓
  [
    "     ##     ",
    "    #++#    ",
    "   #++++#   ",
    "  #++++++#  ",
    " #++++++++# ",
    "############",
    " #oooooooo# ",
    " #o#....#o# ",
    " #o.#..#.o# ",
    " #o..##..o# ",
    " #o.#..#.o# ",
    "############",
  ],
  // 丰收
  [
    "    ####    ",
    "  ##oooo##  ",
    " #ooo..ooo# ",
    "#oo......oo#",
    "#oooo..oooo#",
    "#ooo....ooo#",
    "#oooo..oooo#",
    "#oo......oo#",
    " #ooo..ooo# ",
    "  ##o..o##  ",
    "    ####    ",
    "            ",
  ],
];

const ink: Readonly<Record<string, string>> = { "#": lcd.ink, "+": lcd.dark, o: lcd.mid, ".": lcd.light };

function Crop({ stage, size, faint = false }: { stage: number; size: number; faint?: boolean }) {
  const rows = pictures[Math.min(stage, mergeGoal) - 1]!;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden style={{ opacity: faint ? 0.25 : 1 }}>
      {rows.flatMap((row, y) => [...row].map((c, x) => (ink[c] ? <rect key={`${x},${y}`} x={x} y={y} width={1} height={1} fill={ink[c]} /> : null)))}
    </svg>
  );
}

const tile = 60;
const gap = 4;
const swipeAt = 16;

export function MergeGame() {
  const [g, setG] = game.use();
  const [top, setTop] = best.use();
  /** 丰收 just came up: the field waits for A. */
  const [cheer, setCheer] = useState(false);
  /** A pressed mid-game: start over? */
  const [asking, setAsking] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);

  const start = () => {
    setG(newMerge(Math.floor(Math.random() * 2 ** 31)));
    setCheer(false);
    setAsking(false);
    playSound("plant");
  };
  const slide = (direction: MergeDirection) => {
    const now = game.get();
    if (!now || now.over || cheer || asking) return;
    const next = slideMerge(now, direction);
    if (next === now) return;
    const was = mergeTop(now);
    const reached = mergeTop(next);
    if (next.score > best.get()) setTop(next.score);
    if (reached >= mergeGoal && was < mergeGoal) {
      setCheer(true);
      playSound("achievement");
    } else if (next.over) playSound("nope");
    else if (reached > was) playSound("ripe");
    else playSound(next.grown.length > 0 ? "pick" : "tap");
    setG(next);
  };
  const back = () => {
    const now = game.get();
    if (!now?.previous) return;
    playSound("shovel");
    setCheer(false);
    setG(undoMerge(now));
  };

  usePad((button, down) => {
    if (!down) return;
    const now = game.get();
    if (!now) return void (button === "a" && start());
    if (asking) {
      if (button === "a") start();
      if (button === "b") setAsking(false);
      return;
    }
    if (cheer) return void (button === "a" && setCheer(false));
    switch (button) {
      case "a":
        return now.over ? start() : setAsking(true);
      case "b":
        return back();
      default:
        return slide(button);
    }
  });

  const swiped = (x: number, y: number) => {
    const from = touch.current;
    touch.current = null;
    if (!from) return;
    const dx = x - from.x;
    const dy = y - from.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < swipeAt) return;
    slide(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
  };

  const reached = g ? mergeTop(g) : 0;
  const score = g?.score ?? 0;
  const board = g?.board ?? Array<number>(mergeSize * mergeSize).fill(0);
  const side = mergeSize * tile + (mergeSize + 1) * gap;
  const overlay = !g
    ? ["种田 2048", "按 A 开始"]
    : asking
      ? ["重新种这块地？", "A 重开 · B 接着种"]
      : cheer
        ? ["丰收了！", "按 A 接着种"]
        : g.over
          ? [`地种满了 · ${score} 分`, "按 A 再来 · B 悔一步"]
          : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 px-2 pt-2">
      <div className="flex w-full px-1">
        <span>种田 2048</span>
        <span className="ml-auto tabular-nums">最好 {Math.max(top, score)}</span>
      </div>
      <div className="flex w-full px-1">
        <span className="tabular-nums">分数 {score}</span>
        <span className="ml-auto">{reached ? `种到 ${mergeStageName(reached)}` : ""}</span>
      </div>
      <div
        role="img"
        aria-label={g ? `田里：${board.filter((c) => c).length} 株，最高 ${mergeStageName(Math.max(reached, 1))}` : "种田 2048"}
        className="relative grid shrink-0 touch-none"
        style={{ width: side, height: side, padding: gap, gap, gridTemplateColumns: `repeat(${mergeSize}, ${tile}px)`, background: lcd.dark }}
        onPointerDown={(e) => (touch.current = { x: e.clientX, y: e.clientY })}
        onPointerUp={(e) => swiped(e.clientX, e.clientY)}
        onPointerCancel={() => (touch.current = null)}
      >
        {board.map((stage, i) => (
          <div
            key={i}
            className="flex flex-col items-center justify-center"
            style={{ background: stage ? lcd.paper : lcd.light, boxShadow: g?.grown.includes(i) ? `inset 0 0 0 2px ${lcd.ink}` : undefined }}
          >
            {stage > 0 && (
              <>
                <Crop stage={stage} size={36} />
                <span className="leading-[14px]">{mergeStageName(stage)}</span>
              </>
            )}
          </div>
        ))}
        {overlay && (
          <div className="absolute inset-0 grid place-items-center bg-[#c9dc9a]/80 text-center">
            <span>
              {overlay[0]}
              <br />
              <span className="phone-blink">{overlay[1]}</span>
            </span>
          </div>
        )}
      </div>
      <div className="flex gap-0.5" aria-label="收成图鉴">
        {mergeStages.map((name, i) => (
          <span key={name} title={name}>
            <Crop stage={i + 1} size={24} faint={i + 1 > reached} />
          </span>
        ))}
      </div>
      <p className="mt-auto mb-1 text-center leading-[1.625]" style={{ color: lcd.dark }}>
        方向键或划一下：一样的两株长成下一样
        <br />B 悔一步 · A 重开
      </p>
    </div>
  );
}

const iconTiles: readonly (readonly string[])[] = [
  ["    ", " ## ", " ## ", "    "],
  ["#  #", " ## ", " #  ", " #  "],
  [" ## ", "#  #", " ## ", "  # "],
  ["# # ", "# # ", "+ + ", "+ + "],
];

/** Four tiles, seed, sprout, flower and wheat: each a dark frame round a 4×4 crop on the screen's paper. */
export function MergeIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 13 13" shapeRendering="crispEdges" aria-hidden>
      {iconTiles.map((rows, t) => {
        const ox = (t % 2) * 7;
        const oy = Math.floor(t / 2) * 7;
        return (
          <g key={t}>
            <rect x={ox} y={oy} width={6} height={6} fill={lcd.dark} />
            <rect x={ox + 1} y={oy + 1} width={4} height={4} fill={lcd.paper} />
            {rows.flatMap((row, y) =>
              [...row].map((c, x) => (ink[c] ? <rect key={`${x},${y}`} x={ox + 1 + x} y={oy + 1 + y} width={1} height={1} fill={ink[c]} /> : null)),
            )}
          </g>
        );
      })}
    </svg>
  );
}
