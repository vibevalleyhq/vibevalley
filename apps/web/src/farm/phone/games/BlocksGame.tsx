import { t } from "@vibevalley/i18n";
// 方块 on the phone: the rules are farm/phone/games/blocks.ts; here the clock, the pad and the drawing.
// Leaving the game (or putting the phone away) pauses it where it is.

import { createEffect, createSignal, For, Show } from "solid-js";
import { type Blocks, blocksHeight, blocksWidth, cellsOf, fall, fallMs, landingOf, newBlocks, type PieceKind, pieceKinds, shift, slam, turn } from "./blocks";
import { lcd } from "../lcd";
import { playSound } from "../../../ui/pixel/sound";
import { kept, usePad, useTicks } from "../../support";

const game = kept<Blocks | null>(null);
const best = kept(0);

const cellSmall = 9;
const cellBig = 14;

/** The light ones get an inner square, so they read on the screen. */
const shade = [lcd.dark, lcd.ink, lcd.dark, lcd.mid, lcd.ink, lcd.mid, lcd.dark];

export function BlocksGame(props: { big?: boolean }) {
  const cell = () => (props.big ? cellBig : cellSmall);
  const [g, setG] = game.use();
  const [top, setTop] = best.use();
  const [playing, setPlaying] = createSignal(false);
  let since = 0;
  let canvas: HTMLCanvasElement | undefined;

  const start = () => {
    setG(newBlocks(Math.floor(Math.random() * 2 ** 31)));
    since = 0;
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

  useTicks(
    () => playing() && !!g() && !g()!.over,
    (ms) => {
      const now = game.get();
      if (!now) return;
      since += ms;
      if (since >= fallMs(now.level)) {
        since = 0;
        apply(fall(now));
      }
    },
  );

  usePad((button, down) => {
    if (!down) return;
    const now = game.get();
    if (!now || now.over) return void (button === "a" && start());
    if (!playing()) return void (button === "a" && setPlaying(true));
    switch (button) {
      case "left":
        return apply(shift(now, -1));
      case "right":
        return apply(shift(now, 1));
      case "up":
        return apply(turn(now));
      case "down":
        since = 0;
        return apply(fall(now));
      case "a":
        playSound("thud");
        return apply(slam(now));
      case "b":
        return setPlaying(false);
    }
  });

  createEffect(
    () => [g(), cell()] as const,
    ([state, size]) => {
      const ctx = canvas?.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = lcd.paper;
      ctx.fillRect(0, 0, blocksWidth * size, blocksHeight * size);
      const b = Math.max(1, Math.round(size / 7));
      const block = (x: number, y: number, fill: string | null) => {
        if (y < 0) return;
        const px = x * size;
        const py = y * size;
        if (fill === null) {
          ctx.fillStyle = lcd.light;
          ctx.fillRect(px + b, py + b, size - 2 * b, size - 2 * b);
          return;
        }
        ctx.fillStyle = fill;
        ctx.fillRect(px, py, size - 1, size - 1);
        ctx.fillStyle = lcd.light;
        ctx.fillRect(px + 2 * b, py + 2 * b, size - 1 - 4 * b, size - 1 - 4 * b);
        ctx.fillStyle = fill;
        ctx.fillRect(px + 3 * b, py + 3 * b, size - 1 - 6 * b, size - 1 - 6 * b);
      };
      if (!state) return;
      state.well.forEach((c, i) => c && block(i % blocksWidth, Math.floor(i / blocksWidth), shade[c - 1]!));
      if (!state.over) {
        for (const [x, y] of cellsOf(landingOf(state))) block(x, y, null);
        for (const [x, y] of cellsOf(state.piece)) block(x, y, shade[pieceKinds.indexOf(state.piece.kind)]!);
      }
    },
  );

  return (
    <div class={["flex min-h-0 flex-1 px-2 pt-2", props.big ? "gap-4" : "gap-2"]}>
      <div class="relative shrink-0 self-start" style={{ "box-shadow": `0 0 0 2px ${lcd.ink}` }}>
        <canvas
          ref={(el) => (canvas = el)}
          width={blocksWidth * cell()}
          height={blocksHeight * cell()}
          class="block [image-rendering:pixelated]"
          aria-label={t("web.farm.phone.blocks.well")}
          role="img"
        />
        <Show when={!g() || g()!.over || !playing()}>
          <div class="absolute inset-0 grid place-items-center bg-lcd-paper/80 text-center">
            <span>
              {g()?.over ? t("web.farm.phone.blocks.noRoom") : g() ? t("web.farm.phone.paused") : t("web.farm.phone.game.blocks")}
              <br />
              <span class="phone-blink">
                {t("web.farm.phone.pressA", { what: g() && !g()!.over ? t("web.farm.phone.resume") : t("web.farm.phone.start") })}
              </span>
            </span>
          </div>
        </Show>
      </div>
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <Next kind={g()?.next} />
        <Stat label={t("web.farm.phone.blocks.score")} value={g()?.score ?? 0} />
        <Stat label={t("web.farm.phone.blocks.lines")} value={g()?.lines ?? 0} />
        <Stat label={t("web.farm.phone.blocks.level")} value={g()?.level ?? 1} />
        <Stat label={t("web.farm.phone.blocks.best")} value={Math.max(top(), g()?.score ?? 0)} />
        <p class="mt-auto mb-1 leading-[1.625]" style={{ color: lcd.dark }}>
          {t("web.farm.phone.blocks.help")}
          <br />
          {t("web.farm.phone.blocks.help2")}
          <br />
          {t("web.farm.phone.blocks.help3")}
        </p>
      </div>
    </div>
  );
}

function Next(props: { kind: PieceKind | undefined }) {
  const cells = () => (props.kind ? cellsOf({ kind: props.kind, turn: 0, x: 0, y: 0 }) : []);
  return (
    <div>
      <span>{t("web.farm.phone.blocks.next")}</span>
      <svg width={36} height={20} viewBox="0 0 4 2" shape-rendering="crispEdges" class="mt-1 block p-1" style={{ background: lcd.light }} aria-hidden="true">
        <For each={cells()}>{([x, y]) => <rect x={x} y={y === 0 ? 0 : 1} width={0.9} height={0.9} fill={lcd.ink} />}</For>
      </svg>
    </div>
  );
}

function Stat(props: { label: string; value: number }) {
  return (
    <div class="flex">
      <span>{props.label}</span>
      <span class="ml-auto tabular-nums">{props.value}</span>
    </div>
  );
}
