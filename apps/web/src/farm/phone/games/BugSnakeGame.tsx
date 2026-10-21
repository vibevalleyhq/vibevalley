// 贪吃虫 on the phone: the rules are bugSnake.ts; here the clock, the pad and the
// drawing, each cell six of the game's pixels, zoomed whole. Leaving the game (or putting the phone away) pauses it.

import { useEffect, useRef, useState } from "react";
import { playSound } from "../../sound";
import { drawPattern, lcd } from "../lcd";
import { kept, usePad, useTicks } from "../pad";
import {
  type BugSnake,
  type BugSnakeEnd,
  bugSnakeHeight,
  bugSnakeStepMs,
  bugSnakeWidth,
  crawlBugSnake,
  newBugSnake,
  type SnakeHeading,
  steerBugSnake,
} from "./bugSnake";

const cell = 6;
const zoom = 3;
const width = bugSnakeWidth * cell;
const height = bugSnakeHeight * cell;

const game = kept<BugSnake | null>(null);
const best = kept(0);

/** The head looking right; the other ways are it turned. */
const head = [" #### ", "####.#", "######", "######", "####.#", " #### "];
/** Body segments, striped light and dark, and the tail"s tip. */
const segment = [
  [" #### ", "#++++#", "#++++#", "#++++#", "#++++#", " #### "],
  [" #### ", "#....#", "#....#", "#....#", "#....#", " #### "],
];
const tail = ["      ", "  ##  ", " #++# ", " #++# ", "  ##  ", "      "];
const seed = ["   #  ", "  #+# ", " #++# ", " #++# ", "  ##  ", "      "];
/** The bug, its legs in two frames. */
const bug = [
  [" #  # ", "# ## #", " #### ", "######", " #### ", "#    #"],
  [" #  # ", "  ##  ", "######", " #### ", "######", "      "],
];

/** Rows turned a quarter clockwise. */
const turned = (rows: readonly string[]) =>
  rows.map((_, y) =>
    rows
      .map((row) => row[y])
      .reverse()
      .join(""),
  );
const heads: Record<SnakeHeading, readonly string[]> = { right: head, down: turned(head), left: turned(turned(head)), up: turned(turned(turned(head))) };

const ended: Record<BugSnakeEnd, string> = { wall: "撞到田埂了", self: "咬到自己了", full: "田里爬满了" };

const five = (n: number) => String(n).padStart(5, "0");

export function BugSnakeGame() {
  const [g, setG] = game.use();
  const [top, setTop] = best.use();
  const [playing, setPlaying] = useState(false);
  const since = useRef(0);
  const canvas = useRef<HTMLCanvasElement>(null);

  const start = () => {
    setG(newBugSnake(Math.floor(Math.random() * 2 ** 31)));
    since.current = 0;
    setPlaying(true);
    playSound("plant");
  };
  const apply = (next: BugSnake) => {
    const was = game.get();
    if (was && next.eaten > was.eaten) playSound("pick");
    if (was && next.bugs > was.bugs) playSound("coin");
    if (was && next.bug !== null && was.bug === null) playSound("bug");
    if (next.over !== null && was?.over == null) {
      playSound("thud");
      setPlaying(false);
      if (next.score > best.get()) setTop(next.score);
    }
    setG(next);
  };

  useTicks(playing && !!g && g.over === null, (ms) => {
    const now = game.get();
    if (!now) return;
    since.current += ms;
    if (since.current >= bugSnakeStepMs(now)) {
      since.current = 0;
      apply(crawlBugSnake(now));
    }
  });

  usePad((button, down) => {
    if (!down) return;
    const now = game.get();
    if (!now || now.over !== null) return void (button === "a" && start());
    if (!playing) return void (button === "a" && setPlaying(true));
    if (button === "b") return setPlaying(false);
    if (button !== "a") setG(steerBugSnake(now, button));
  });

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = lcd.paper;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = lcd.light;
    for (let y = 0; y < bugSnakeHeight; y++) for (let x = 0; x < bugSnakeWidth; x++) ctx.fillRect(x * cell + 2, y * cell + 3, 2, 1);
    if (!g) return;
    const draw = (picture: readonly string[], c: number) => drawPattern(ctx, picture, (c % bugSnakeWidth) * cell, Math.floor(c / bugSnakeWidth) * cell);
    draw(seed, g.food);
    // It blinks its last ten ticks, before it flies off.
    if (g.bug !== null && (g.bugLeft > 10 || Math.floor(g.bugLeft / 2) % 2 === 0)) draw(bug[g.bugLeft % 2]!, g.bug);
    g.body.forEach((c, i) => draw(i === 0 ? heads[g.heading] : i === g.body.length - 1 ? tail : segment[i % 2]!, c));
  }, [g]);

  const score = g?.score ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center px-1 pt-3">
      <div className="flex w-full px-2">
        <span>贪吃虫</span>
        <span className="ml-auto tabular-nums">最好 {five(Math.max(top, score))}</span>
      </div>
      <div className="mt-1 flex w-full px-2 tabular-nums">
        <span>
          种子 {g?.eaten ?? 0} · 虫 {g?.bugs ?? 0}
        </span>
        <span className="ml-auto">{five(score)}</span>
      </div>
      <div className="relative mt-2" style={{ boxShadow: `0 0 0 2px ${lcd.ink}` }}>
        <canvas
          ref={canvas}
          width={width}
          height={height}
          role="img"
          aria-label="贪吃虫的田"
          className="block [image-rendering:pixelated]"
          style={{ width: width * zoom, height: height * zoom }}
        />
        {(!g || g.over !== null || !playing) && (
          <div className="absolute inset-0 grid place-items-center bg-[#c9dc9a]/80 text-center">
            <span>
              {g?.over ? ended[g.over] : g ? "暂停" : "贪吃虫"}
              <br />
              <span className="phone-blink">按 A {g && g.over === null ? "继续" : g ? "再来" : "开始"}</span>
            </span>
          </div>
        )}
      </div>
      <p className="mt-auto mb-2 text-center leading-[1.625]" style={{ color: lcd.dark }}>
        方向键转弯，B 暂停
        <br />
        吃种子长一节，虫子飞走前吃掉多得分
      </p>
    </div>
  );
}

/** A caterpillar on the ground, heading for a seed. */
export function BugSnakeIcon() {
  const rows = ["    # #   ", "    ###   ", "++..#o#  #", "++..###  +"];
  const fill: Readonly<Record<string, string>> = { "#": lcd.ink, "+": lcd.dark, ".": lcd.mid, o: lcd.paper };
  return (
    <svg width="28" height="28" viewBox="0 -1 10 10" shapeRendering="crispEdges" aria-hidden>
      {rows.flatMap((row, y) => [...row].map((c, x) => (fill[c] ? <rect key={`${x},${y}`} x={x} y={y + 2} width={1} height={1} fill={fill[c]} /> : null)))}
      <rect x="0" y="6" width="10" height="1" fill={lcd.dark} />
    </svg>
  );
}
