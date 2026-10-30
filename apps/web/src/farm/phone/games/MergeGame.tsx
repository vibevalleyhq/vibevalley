// 种田 2048 on the phone: the rules are farm/phone/games/merge.ts; here the pad, swipes and the drawing, each stage a
// 12×12 picture. The field is kept while the phone is away or a call comes in. Arrows (or a swipe on the field) slide,
// B takes one slide back, A starts, goes on after 丰收, and asks before starting over.

import { t } from "@vibevalley/i18n";

import { createSignal, For, Show } from "solid-js";
import { type Merge, type MergeDirection, mergeGoal, mergeSize, mergeStageName, mergeStages, mergeTop, newMerge, slideMerge, undoMerge } from "./merge";
import { lcd } from "@/farm/phone/lcd";
import { playSound } from "@/ui/pixel/sound";
import { kept, usePad } from "@/farm/support";

const game = kept<Merge | undefined>(undefined);
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

/** A picture's coloured cells. */
const cellsOf = (rows: readonly string[]) => rows.flatMap((row, y) => [...row].flatMap((c, x) => (ink[c] ? [{ x, y, fill: ink[c] }] : [])));

function Crop(props: { stage: number; size: number; faint?: boolean }) {
  const cells = () => cellsOf(pictures[Math.min(props.stage, mergeGoal) - 1]!);
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 12 12"
      shape-rendering="crispEdges"
      aria-hidden="true"
      style={{ opacity: props.faint === true ? 0.25 : 1 }}
    >
      <For each={cells()}>{(c) => <rect x={c.x} y={c.y} width={1} height={1} fill={c.fill} />}</For>
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
  const [cheer, setCheer] = createSignal(false);
  /** A pressed mid-game: start over? */
  const [asking, setAsking] = createSignal(false);
  let touch: { x: number; y: number } | undefined = undefined;

  const start = () => {
    setG(newMerge(Math.floor(Math.random() * 2 ** 31)));
    setCheer(false);
    setAsking(false);
    playSound("plant");
  };
  const slide = (direction: MergeDirection) => {
    const now = game.get();
    if (!now || now.over || cheer() || asking()) return;
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
    if (asking()) {
      if (button === "a") start();
      if (button === "b") setAsking(false);
      return;
    }
    if (cheer()) return void (button === "a" && setCheer(false));
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
    const from = touch;
    touch = undefined;
    if (!from) return;
    const dx = x - from.x;
    const dy = y - from.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < swipeAt) return;
    slide(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
  };

  const reached = () => {
    const now = g();
    return now ? mergeTop(now) : 0;
  };
  const score = () => g()?.score ?? 0;
  const board = () => g()?.board ?? Array<number>(mergeSize * mergeSize).fill(0);
  const side = mergeSize * tile + (mergeSize + 1) * gap;
  const overlay = () => {
    const now = g();
    return !now
      ? [t("web.farm.phone.game.merge"), t("web.farm.phone.merge.start")]
      : asking()
        ? [t("web.farm.phone.merge.restartAsk"), t("web.farm.phone.merge.restartKeys")]
        : cheer()
          ? [t("web.farm.phone.merge.harvest"), t("web.farm.phone.merge.goOn")]
          : now.over
            ? [t("web.farm.phone.merge.full", { score: score() }), t("web.farm.phone.merge.overKeys")]
            : undefined;
  };
  return (
    <div class="flex min-h-0 flex-1 flex-col items-center gap-1.5 px-2 pt-2">
      <div class="flex w-full px-1">
        <span>{t("web.farm.phone.game.merge")}</span>
        <span class="ml-auto tabular-nums">
          {t("web.farm.phone.blocks.best")} {Math.max(top(), score())}
        </span>
      </div>
      <div class="flex w-full px-1">
        <span class="tabular-nums">
          {t("web.farm.phone.blocks.score")} {score()}
        </span>
        <span class="ml-auto">{reached() !== 0 ? t("web.farm.phone.merge.reached", { stage: mergeStageName(reached()) }) : ""}</span>
      </div>
      <div
        role="img"
        data-testid="merge-board"
        data-count={g() ? board().filter((c) => c !== 0).length : undefined}
        aria-label={
          g()
            ? t("web.farm.phone.merge.field", { n: board().filter((c) => c !== 0).length, top: mergeStageName(Math.max(reached(), 1)) })
            : t("web.farm.phone.game.merge")
        }
        class="relative grid shrink-0 touch-none"
        style={{
          width: `${side}px`,
          height: `${side}px`,
          padding: `${gap}px`,
          gap: `${gap}px`,
          "grid-template-columns": `repeat(${mergeSize}, ${tile}px)`,
          background: lcd.dark,
        }}
        onPointerDown={(e) => (touch = { x: e.clientX, y: e.clientY })}
        onPointerUp={(e) => swiped(e.clientX, e.clientY)}
        onPointerCancel={() => (touch = undefined)}
      >
        <For each={board()} keyed={false}>
          {(stage, i) => (
            <div
              class="flex flex-col items-center justify-center"
              style={{
                background: stage() !== 0 ? lcd.paper : lcd.light,
                "box-shadow": g()?.grown.includes(i) === true ? `inset 0 0 0 2px ${lcd.ink}` : undefined,
              }}
            >
              <Show when={stage() > 0}>
                <Crop stage={stage()} size={36} />
                <span class="leading-[14px]">{mergeStageName(stage())}</span>
              </Show>
            </div>
          )}
        </For>
        <Show when={overlay()}>
          {(o) => (
            <div class="absolute inset-0 grid place-items-center bg-lcd-paper/80 text-center">
              <span>
                {o()[0]}
                <br />
                <span class="phone-blink">{o()[1]}</span>
              </span>
            </div>
          )}
        </Show>
      </div>
      <div class="flex gap-0.5" aria-label={t("web.farm.phone.merge.stages")}>
        <For each={mergeStages}>
          {(name, i) => (
            <span title={name}>
              <Crop stage={i() + 1} size={24} faint={i() + 1 > reached()} />
            </span>
          )}
        </For>
      </div>
      <p class="mt-auto mb-1 text-center leading-[1.625]" style={{ color: lcd.dark }}>
        {t("web.farm.phone.merge.help")}
        <br />
        {t("web.farm.phone.merge.help2")}
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
export function MergeIcon(props: { size?: number }) {
  return (
    <svg width={props.size ?? 28} height={props.size ?? 28} viewBox="0 0 13 13" shape-rendering="crispEdges" aria-hidden="true">
      <For each={iconTiles}>
        {(rows, t) => (
          <g>
            <rect x={(t() % 2) * 7} y={Math.floor(t() / 2) * 7} width={6} height={6} fill={lcd.dark} />
            <rect x={(t() % 2) * 7 + 1} y={Math.floor(t() / 2) * 7 + 1} width={4} height={4} fill={lcd.paper} />
            <For each={cellsOf(rows)}>
              {(c) => <rect x={(t() % 2) * 7 + 1 + c.x} y={Math.floor(t() / 2) * 7 + 1 + c.y} width={1} height={1} fill={c.fill} />}
            </For>
          </g>
        )}
      </For>
    </svg>
  );
}
