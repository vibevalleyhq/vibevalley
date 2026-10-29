import { t } from "@vibevalley/i18n";
// 贪吃虫 on the phone: the rules are farm/phone/games/bugSnake.ts; here the clock, the pad and the drawing, each cell
// six of the game's pixels, zoomed whole. Leaving the game (or putting the phone away) pauses it.

import { createEffect, createSignal, For, Show } from "solid-js";
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
import { drawPattern, lcd } from "../lcd";
import { playSound } from "../../../ui/pixel/sound";
import { kept, usePad, useTicks } from "../../support";

const game = kept<BugSnake | null>(null);
const best = kept(0);

const cell = 6;
const zoom = 3;
const width = bugSnakeWidth * cell;
const height = bugSnakeHeight * cell;

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

const ended: Record<BugSnakeEnd, string> = {
  wall: t("web.farm.phone.bugs.ended.wall"),
  self: t("web.farm.phone.bugs.ended.self"),
  full: t("web.farm.phone.bugs.ended.full"),
};

const five = (n: number) => String(n).padStart(5, "0");

export function BugSnakeGame() {
  const [g, setG] = game.use();
  const [top, setTop] = best.use();
  const [playing, setPlaying] = createSignal(false);
  let since = 0;
  let canvas: HTMLCanvasElement | undefined;

  const start = () => {
    setG(newBugSnake(Math.floor(Math.random() * 2 ** 31)));
    since = 0;
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

  useTicks(
    () => playing() && !!g() && g()!.over === null,
    (ms) => {
      const now = game.get();
      if (!now) return;
      since += ms;
      if (since >= bugSnakeStepMs(now)) {
        since = 0;
        apply(crawlBugSnake(now));
      }
    },
  );

  usePad((button, down) => {
    if (!down) return;
    const now = game.get();
    if (!now || now.over !== null) return void (button === "a" && start());
    if (!playing()) return void (button === "a" && setPlaying(true));
    if (button === "b") {
      setPlaying(false);
      return;
    }
    if (button !== "a") setG(steerBugSnake(now, button));
  });

  createEffect(g, (state) => {
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = lcd.paper;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = lcd.light;
    for (let y = 0; y < bugSnakeHeight; y++) for (let x = 0; x < bugSnakeWidth; x++) ctx.fillRect(x * cell + 2, y * cell + 3, 2, 1);
    if (!state) return;
    const draw = (picture: readonly string[], c: number) => drawPattern(ctx, picture, (c % bugSnakeWidth) * cell, Math.floor(c / bugSnakeWidth) * cell);
    draw(seed, state.food);
    // It blinks its last ten ticks, before it flies off.
    if (state.bug !== null && (state.bugLeft > 10 || Math.floor(state.bugLeft / 2) % 2 === 0)) draw(bug[state.bugLeft % 2]!, state.bug);
    state.body.forEach((c, i) => draw(i === 0 ? heads[state.heading] : i === state.body.length - 1 ? tail : segment[i % 2]!, c));
  });

  const score = () => g()?.score ?? 0;
  return (
    <div class="flex min-h-0 flex-1 flex-col items-center px-1 pt-3">
      <div class="flex w-full px-2">
        <span>{t("web.farm.phone.game.bugs")}</span>
        <span class="ml-auto tabular-nums">
          {t("web.farm.phone.blocks.best")} {five(Math.max(top(), score()))}
        </span>
      </div>
      <div class="mt-1 flex w-full px-2 tabular-nums">
        <span>{t("web.farm.phone.bugs.tally", { seeds: g()?.eaten ?? 0, bugs: g()?.bugs ?? 0 })}</span>
        <span class="ml-auto">{five(score())}</span>
      </div>
      <div class="relative mt-2" style={{ "box-shadow": `0 0 0 2px ${lcd.ink}` }}>
        <canvas
          ref={(el) => (canvas = el)}
          width={width}
          height={height}
          role="img"
          aria-label={t("web.farm.phone.bugs.field")}
          class="block [image-rendering:pixelated]"
          style={{ width: `${width * zoom}px`, height: `${height * zoom}px` }}
        />
        <Show when={!g() || g()!.over !== null || !playing()}>
          <div class="absolute inset-0 grid place-items-center bg-lcd-paper/80 text-center">
            <span>
              {g()?.over ? ended[g()!.over!] : g() ? t("web.farm.phone.paused") : t("web.farm.phone.game.bugs")}
              <br />
              <span class="phone-blink">
                {t("web.farm.phone.pressA", {
                  what: g() && g()!.over === null ? t("web.farm.phone.resume") : g() ? t("web.farm.phone.again") : t("web.farm.phone.start"),
                })}
              </span>
            </span>
          </div>
        </Show>
      </div>
      <p class="mt-auto mb-2 text-center leading-[1.625]" style={{ color: lcd.dark }}>
        {t("web.farm.phone.bugs.help")}
        <br />
        {t("web.farm.phone.bugs.help2")}
      </p>
    </div>
  );
}

/** A caterpillar on the ground, heading for a seed. */
export function BugSnakeIcon(props: { size?: number }) {
  const rows = ["    # #   ", "    ###   ", "++..#o#  #", "++..###  +"];
  const fill: Readonly<Record<string, string>> = { "#": lcd.ink, "+": lcd.dark, ".": lcd.mid, o: lcd.paper };
  const cells = rows.flatMap((row, y) => [...row].flatMap((c, x) => (fill[c] ? [{ x, y, fill: fill[c] }] : [])));
  return (
    <svg width={props.size ?? 28} height={props.size ?? 28} viewBox="0 -1 10 10" shape-rendering="crispEdges" aria-hidden="true">
      <For each={cells}>{(c) => <rect x={c.x} y={c.y + 2} width={1} height={1} fill={c.fill} />}</For>
      <rect x="0" y="6" width="10" height="1" fill={lcd.dark} />
    </svg>
  );
}
