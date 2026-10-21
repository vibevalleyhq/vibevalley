// 方块 on the phone: the rules are blocks.ts; here the clock, the pad and the drawing.
// Leaving the game (or putting the phone away) pauses it where it is.

import { useEffect, useRef, useState } from "react";
import { playSound } from "../../sound";
import { lcd } from "../lcd";
import { kept, usePad, useTicks } from "../pad";
import { type Blocks, blocksHeight, blocksWidth, cellsOf, fall, fallMs, landingOf, newBlocks, type PieceKind, pieceKinds, shift, slam, turn } from "./blocks";

const game = kept<Blocks | null>(null);
const best = kept(0);

const cellSmall = 9;
const cellBig = 14;

/** The light ones get an inner square, so they read on the screen. */
const shade = [lcd.dark, lcd.ink, lcd.dark, lcd.mid, lcd.ink, lcd.mid, lcd.dark];

export function BlocksGame({ big = false }: { big?: boolean }) {
  const cell = big ? cellBig : cellSmall;
  const [g, setG] = game.use();
  const [top, setTop] = best.use();
  const [playing, setPlaying] = useState(false);
  const since = useRef(0);
  const canvas = useRef<HTMLCanvasElement>(null);

  const start = () => {
    setG(newBlocks(Math.floor(Math.random() * 2 ** 31)));
    since.current = 0;
    setPlaying(true);
    playSound("plant");
  };
  const apply = (next: Blocks) => {
    const was = game.get();
    if (next.lines > (was?.lines ?? 0)) playSound("coin");
    if (next.over && !was?.over) {
      playSound("nope");
      setPlaying(false);
      if (next.score > best.get()) setTop(next.score);
    }
    setG(next);
  };

  useTicks(playing && !!g && !g.over, (ms) => {
    const now = game.get();
    if (!now) return;
    since.current += ms;
    if (since.current >= fallMs(now.level)) {
      since.current = 0;
      apply(fall(now));
    }
  });

  usePad((button, down) => {
    if (!down) return;
    const now = game.get();
    if (!now || now.over) return void (button === "a" && start());
    if (!playing) return void (button === "a" && setPlaying(true));
    switch (button) {
      case "left":
        return apply(shift(now, -1));
      case "right":
        return apply(shift(now, 1));
      case "up":
        return apply(turn(now));
      case "down":
        since.current = 0;
        return apply(fall(now));
      case "a":
        playSound("thud");
        return apply(slam(now));
      case "b":
        return setPlaying(false);
    }
  });

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = lcd.paper;
    ctx.fillRect(0, 0, blocksWidth * cell, blocksHeight * cell);
    const b = Math.max(1, Math.round(cell / 7));
    const block = (x: number, y: number, fill: string | null) => {
      if (y < 0) return;
      const px = x * cell;
      const py = y * cell;
      if (fill === null) {
        ctx.fillStyle = lcd.light;
        ctx.fillRect(px + b, py + b, cell - 2 * b, cell - 2 * b);
        return;
      }
      ctx.fillStyle = fill;
      ctx.fillRect(px, py, cell - 1, cell - 1);
      ctx.fillStyle = lcd.light;
      ctx.fillRect(px + 2 * b, py + 2 * b, cell - 1 - 4 * b, cell - 1 - 4 * b);
      ctx.fillStyle = fill;
      ctx.fillRect(px + 3 * b, py + 3 * b, cell - 1 - 6 * b, cell - 1 - 6 * b);
    };
    if (!g) return;
    g.well.forEach((c, i) => c && block(i % blocksWidth, Math.floor(i / blocksWidth), shade[c - 1]!));
    if (!g.over) {
      for (const [x, y] of cellsOf(landingOf(g))) block(x, y, null);
      for (const [x, y] of cellsOf(g.piece)) block(x, y, shade[pieceKinds.indexOf(g.piece.kind)]!);
    }
  }, [g, cell]);

  return (
    <div className={`flex min-h-0 flex-1 px-2 pt-2 ${big ? "gap-4" : "gap-2"}`}>
      <div className="relative shrink-0 self-start" style={{ boxShadow: `0 0 0 2px ${lcd.ink}` }}>
        <canvas
          ref={canvas}
          width={blocksWidth * cell}
          height={blocksHeight * cell}
          className="block [image-rendering:pixelated]"
          aria-label="方块的井"
          role="img"
        />
        {(!g || g.over || !playing) && (
          <div className="absolute inset-0 grid place-items-center bg-[#c9dc9a]/80 text-center">
            <span>
              {g?.over ? "没地方了" : g ? "暂停" : "方块"}
              <br />
              <span className="phone-blink">按 A {g && !g.over ? "继续" : "开始"}</span>
            </span>
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Next kind={g?.next} />
        <Stat label="分数" value={g?.score ?? 0} />
        <Stat label="行" value={g?.lines ?? 0} />
        <Stat label="级" value={g?.level ?? 1} />
        <Stat label="最好" value={Math.max(top, g?.score ?? 0)} />
        <p className="mt-auto mb-1 leading-[1.625]" style={{ color: lcd.dark }}>
          ←→ 移 ↑ 转
          <br />↓ 落 A 到底
          <br />B 暂停
        </p>
      </div>
    </div>
  );
}

function Next({ kind }: { kind: PieceKind | undefined }) {
  const cells = kind ? cellsOf({ kind, turn: 0, x: 0, y: 0 }) : [];
  return (
    <div>
      <span>下一个</span>
      <svg width={36} height={20} viewBox="0 0 4 2" shapeRendering="crispEdges" className="mt-1 block p-1" style={{ background: lcd.light }} aria-hidden>
        {cells.map(([x, y]) => (
          <rect key={`${x},${y}`} x={x} y={y === 0 ? 0 : 1} width={0.9} height={0.9} fill={lcd.ink} />
        ))}
      </svg>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex">
      <span>{label}</span>
      <span className="ml-auto tabular-nums">{value}</span>
    </div>
  );
}
