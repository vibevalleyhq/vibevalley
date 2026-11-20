import { Canvas, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { createSignal } from "../../solid";
import { playSound } from "../../web/ui/pixel/sound";
import { lcd } from "./lcd";
import { Cover, Help, Words, Stats } from "./LcdView";
import { type Merge, type MergeDirection, mergeGoal, mergeSize, mergeStageName, mergeStages, mergeTop, newMerge, slideMerge, undoMerge } from "./merge";
import { kept, usePad } from "./pad";

const game = kept<Merge | undefined>(undefined);
const best = kept(0);

/** 12×12: `#` ink, `+` dark, `o` mid, `.` light. */
const pictures: readonly (readonly string[])[] = [
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

const tile = 60,
  gap = 4,
  swipeAt = 16;
const side = mergeSize * tile + (mergeSize + 1) * gap;

function Crop(props: { stage: number; size: number; faint?: boolean }) {
  return (
    <Canvas
      style={{ width: props.size, height: props.size, opacity: props.faint === true ? 0.25 : 1 }}
      draw={(cx) => {
        const cells = cellsOf(pictures[Math.min(props.stage, mergeGoal) - 1] ?? []);
        for (const c of cells) {
          cx.fillStyle = c.fill;
          cx.fillRect(
            Math.round((c.x * props.size) / 12),
            Math.round((c.y * props.size) / 12),
            Math.round(((c.x + 1) * props.size) / 12) - Math.round((c.x * props.size) / 12),
            Math.round(((c.y + 1) * props.size) / 12) - Math.round((c.y * props.size) / 12),
          );
        }
      }}
    />
  );
}
export function MergeGame() {
  const [g, setG] = game.use();
  const [top, setTop] = best.use();
  /** the top crop just came up: the field waits for A. */
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
    <View testID="merge" class="flex-1 items-center gap-1.5 px-2 pt-2">
      <Stats label={t("web.farm.phone.game.merge")} value={t("web.farm.phone.blocks.best") + " " + Math.max(top(), score())} />
      <Stats
        label={t("web.farm.phone.blocks.score") + " " + score()}
        value={reached() > 0 ? t("web.farm.phone.merge.reached", { stage: mergeStageName(reached()) }) : ""}
      />
      <View
        testID="merge-board"
        role="image"
        accessible
        accessibilityLabel={
          g()
            ? t("web.farm.phone.merge.field", { n: board().filter((v) => v !== 0).length, top: mergeStageName(Math.max(reached(), 1)) })
            : t("web.farm.phone.game.merge")
        }
        onPressDown={(e) => (touch = { x: e.pagePosition.x, y: e.pagePosition.y })}
        onPressUp={(e) => swiped(e.pagePosition.x, e.pagePosition.y)}
        style={{ width: side, height: side, flexShrink: 0, position: "relative", backgroundColor: lcd.dark }}
      >
        <Each of={Array.from({ length: 16 }, (_, i) => i)}>
          {(n) => (
            <View
              style={{
                position: "absolute",
                left: gap + (n() % 4) * (gap + tile),
                top: gap + Math.floor(n() / 4) * (gap + tile),
                height: tile,
                width: tile,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: g()?.grown.includes(n()) === true ? 2 : 0,
                borderColor: lcd.ink,
                backgroundColor: (board()[n()] ?? 0) > 0 ? lcd.paper : lcd.light,
              }}
            >
              <If when={board()[n()]}>
                {(stage) => (
                  <View class="items-center">
                    <Crop stage={stage()} size={36} />
                    <Words>{mergeStageName(stage())}</Words>
                  </View>
                )}
              </If>
            </View>
          )}
        </Each>
        <If when={overlay()}>{(lines) => <Cover lines={lines()} />}</If>
      </View>
      <View accessible accessibilityLabel={t("web.farm.phone.merge.stages")} class="flex-row gap-0.5">
        <Each of={mergeStages}>{(_, i) => <Crop stage={i() + 1} size={24} faint={i() + 1 > reached()} />}</Each>
      </View>
      <Help lines={[t("web.farm.phone.merge.help"), t("web.farm.phone.merge.help2")]} />
    </View>
  );
}
