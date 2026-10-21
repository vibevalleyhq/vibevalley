// 小恐龙 on the phone: the rules are dino.ts; here the clock, the pad and the drawing,
// zoomed whole. A or up jumps, down or B ducks; leaving the game ends the run.

import { useEffect, useRef, useState } from "react";
import { playSound } from "../../sound";
import { drawPattern, lcd } from "../lcd";
import { kept, usePad, useTicks } from "../pad";
import { type Dino, dinoBox, dinoGround, dinoHeight, dinoScore, dinoWidth, duck, jump, newDino, type Obstacle, run } from "./dino";

const best = kept(0);

/** 12×14, two running frames; ducking, 16×8. */
const runFrames = [
  [
    "      ####  ",
    "     ## ### ",
    "     #######",
    "     ####   ",
    "#    ######",
    "##  #####   ",
    "########### ",
    " #########  ",
    "  ########  ",
    "   ######   ",
    "    ##  #   ",
    "    #   ##  ",
    "    ##      ",
    "            ",
  ],
  [
    "      ####  ",
    "     ## ### ",
    "     #######",
    "     ####   ",
    "#    ######",
    "##  #####   ",
    "########### ",
    " #########  ",
    "  ########  ",
    "   ######   ",
    "    #  ##   ",
    "   ##   #   ",
    "        ##  ",
    "            ",
  ],
] as const;
const duckFrames = [
  [
    "           ##### ",
    "#  ########## ###",
    "############### ",
    " ##########     ",
    "  #######       ",
    "   #  ##        ",
    "   ##  #        ",
    "       ##       ",
  ],
  [
    "           ##### ",
    "#  ########## ###",
    "############### ",
    " ##########     ",
    "  #######       ",
    "   ## #         ",
    "      ##        ",
    "                ",
  ],
] as const;
const cactus = [" ++   ", " ++ + ", "+++ + ", "+++++ ", " ++   ", " ++   ", " ++   ", " ++   ", " ++   ", " ++   ", " ++   ", " ++   "];
const cacti = [
  " +     +    ",
  "+++ + +++   ",
  "+++ +++++ + ",
  "+++++++++++ ",
  "+++ +++++   ",
  "+++++++++   ",
  "+++ ++++++  ",
  "+++ +++++   ",
  "+++ +++++   ",
  "+++ +++++   ",
];
const bird = [
  ["   #        ", "  ###       ", " ###### ##  ", "#########   ", "   ######   ", "    ###     ", "            ", "            "],
  ["            ", "            ", " ###### ##  ", "#########   ", "   ######   ", "    ####    ", "     ##     ", "      #     "],
] as const;

const picture = (o: Obstacle, t: number): readonly string[] => (o.kind === "bird" ? bird[Math.floor(t / 180) % 2]! : o.kind === "cactus" ? cactus : cacti);

const five = (n: number) => String(n).padStart(5, "0");

export function DinoGame({ big = false }: { big?: boolean }) {
  const zoom = big ? 3 : 2;
  const [d, setD] = useState<Dino | null>(null);
  const [top, setTop] = best.use();
  const canvas = useRef<HTMLCanvasElement>(null);
  const playing = !!d && !d.over;

  const start = () => {
    setD(jump(newDino(Math.floor(Math.random() * 2 ** 31))));
    playSound("yip");
  };

  useTicks(playing, (ms) => {
    if (!d) return;
    const next = run(d, ms);
    if (next.over) {
      playSound("thud");
      if (dinoScore(next) > best.get()) setTop(dinoScore(next));
    }
    setD(next);
  });

  usePad((button, down) => {
    const jumpKey = button === "a" || button === "up";
    if (!d || d.over) return void (down && jumpKey && start());
    if (jumpKey && down) {
      if (d.lift === 0) playSound("tap");
      return setD(jump(d));
    }
    if (button === "down" || button === "b") setD(duck(d, down));
  });

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = lcd.paper;
    ctx.fillRect(0, 0, dinoWidth, dinoHeight);
    const run0 = d ?? newDino(0);
    ctx.fillStyle = lcd.dark;
    ctx.fillRect(0, dinoGround, dinoWidth, 1);
    ctx.fillStyle = lcd.mid;
    const walked = Math.floor(run0.distance);
    for (let x = -(walked % 23); x < dinoWidth; x += 23) ctx.fillRect(x + 4, dinoGround + 3, 2, 1);
    for (let x = -((walked * 2) % 37); x < dinoWidth; x += 37) ctx.fillRect(x + 20, dinoGround + 5, 1, 1);
    for (const o of run0.obstacles) drawPattern(ctx, picture(o, run0.time), o.x, o.y);
    const box = dinoBox(run0);
    const frame = Math.floor(run0.time / 110) % 2;
    const ducking = run0.ducking && run0.lift === 0;
    drawPattern(ctx, ducking ? duckFrames[frame]! : runFrames[run0.lift > 0 ? 0 : frame]!, box.x, box.y);
  }, [d]);

  const score = d ? dinoScore(d) : 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center px-1 pt-3">
      <div className="flex w-full px-1">
        <span>小恐龙</span>
        <span className="ml-auto tabular-nums">最好 {five(Math.max(top, score))}</span>
      </div>
      <div className="mt-1 w-full px-1 text-right tabular-nums">{five(score)}</div>
      <div className="relative mt-2" style={{ boxShadow: `0 0 0 2px ${lcd.ink}` }}>
        <canvas
          ref={canvas}
          width={dinoWidth}
          height={dinoHeight}
          role="img"
          aria-label="小恐龙的路"
          className="block [image-rendering:pixelated]"
          style={{ width: dinoWidth * zoom, height: dinoHeight * zoom }}
        />
        {!playing && (
          <div className="absolute inset-0 grid place-items-center text-center">
            <span className="px-2" style={{ background: lcd.paper }}>
              {d?.over ? "撞上了" : "小恐龙"} · <span className="phone-blink">按 A {d?.over ? "再来" : "开始"}</span>
            </span>
          </div>
        )}
      </div>
      <p className="mt-auto mb-2 text-center leading-[1.625]" style={{ color: lcd.dark }}>
        A 或 ↑ 跳，↓ 或 B 蹲
        <br />
        跑得越远越快，后面会有鸟
      </p>
    </div>
  );
}
