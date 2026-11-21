import { View, type CanvasRenderingContext2D } from "nsh";

import { t } from "@vibevalley/i18n";

import { createSignal } from "../../solid";
import { playSound } from "../../web/ui/pixel/sound";
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
import { lcd, drawPattern } from "./lcd";
import { Board, Cover, Help, Stats } from "./LcdView";
import { kept, usePad, useTicks } from "./pad";

const cell = 6;
const zoom = 3;
const width = bugSnakeWidth * cell;
const height = bugSnakeHeight * cell;

const game = kept<BugSnake | undefined>(undefined);
const best = kept(0);

/** The head looking right; the other ways are it turned. */
const head = [" #### ", "####.#", "######", "######", "####.#", " #### "];
/** Body segments, striped light and dark, and the tail"s tip. */
const segment = [
  [" #### ", "#++++#", "#++++#", "#++++#", "#++++#", " #### "],
  [" #### ", "#....#", "#....#", "#....#", "#....#", " #### "],
] as const;
const tail = ["      ", "  ##  ", " #++# ", " #++# ", "  ##  ", "      "];
const seed = ["   #  ", "  #+# ", " #++# ", " #++# ", "  ##  ", "      "];
/** The bug, its legs in two frames. */
const bug = [
  [" #  # ", "# ## #", " #### ", "######", " #### ", "#    #"],
  [" #  # ", "  ##  ", "######", " #### ", "######", "      "],
] as const;

/** Rows turned a quarter clockwise. */
const turned = (rows: readonly string[]) =>
  rows.map((_, y) =>
    rows
      .map((row) => row[y])
      .toReversed()
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
    if (was && next.bug !== undefined && was.bug === undefined) playSound("bug");
    if (next.over !== undefined && was?.over === undefined) {
      playSound("thud");
      setPlaying(false);
      if (next.score > best.get()) setTop(next.score);
    }
    setG(next);
  };

  useTicks(
    () => playing() && !!g() && g()?.over === undefined,
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
    if (!now || now.over !== undefined) return void (button === "a" && start());
    if (!playing()) return void (button === "a" && setPlaying(true));
    if (button === "b") {
      setPlaying(false);
      return;
    }
    if (button !== "a") setG(steerBugSnake(now, button));
  });

  const draw = (ctx: CanvasRenderingContext2D) => {
    const state = g();
    ctx.fillStyle = lcd.paper;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = lcd.light;
    for (let y = 0; y < bugSnakeHeight; y++) for (let x = 0; x < bugSnakeWidth; x++) ctx.fillRect(x * cell + 2, y * cell + 3, 2, 1);
    if (!state) return;
    const draw = (picture: readonly string[], c: number) => drawPattern(ctx, picture, (c % bugSnakeWidth) * cell, Math.floor(c / bugSnakeWidth) * cell);
    draw(seed, state.food);
    // It blinks its last ten ticks, before it flies off.
    if (state.bug !== undefined && (state.bugLeft > 10 || Math.floor(state.bugLeft / 2) % 2 === 0)) draw(state.bugLeft % 2 === 0 ? bug[0] : bug[1], state.bug);
    state.body.forEach((c, i) => draw(i === 0 ? heads[state.heading] : i === state.body.length - 1 ? tail : i % 2 === 0 ? segment[0] : segment[1], c));
  };
  const score = () => g()?.score ?? 0;
  const status = () => {
    const over = g()?.over;
    return over ? ended[over] : g() ? t("web.farm.phone.paused") : t("web.farm.phone.game.bugs");
  };
  return (
    <View testID="bugs" class="flex-1 items-center px-1 pt-3">
      <Stats label={t("web.farm.phone.game.bugs")} value={t("web.farm.phone.blocks.best") + " " + five(Math.max(score(), top()))} />
      <View class="mt-1 mb-2 w-full">
        <Stats label={t("web.farm.phone.bugs.tally", { seeds: g()?.eaten ?? 0, bugs: g()?.bugs ?? 0 })} value={five(score())} />
      </View>
      <Board label={t("web.farm.phone.bugs.field")} width={width} height={height} zoom={zoom} draw={draw}>
        <If when={!playing() || g()?.over !== undefined}>
          <Cover
            lines={[
              status(),
              t("web.farm.phone.pressA", { what: t(g()?.over ? "web.farm.phone.again" : g() ? "web.farm.phone.resume" : "web.farm.phone.start") }),
            ]}
          />
        </If>
      </Board>
      <Help lines={[t("web.farm.phone.bugs.help"), t("web.farm.phone.bugs.help2")]} />
    </View>
  );
}
