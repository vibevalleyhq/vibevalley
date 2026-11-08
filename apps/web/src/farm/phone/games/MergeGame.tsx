import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { lcd } from "#/farm/phone/lcd.ts";
import { kept, usePad } from "#/farm/phone/pad.ts";
import { playSound } from "#/ui/pixel/sound.ts";

import { type Merge, type MergeDirection, mergeGoal, mergeSize, mergeStageName, mergeStages, mergeTop, newMerge, slideMerge, undoMerge } from "./merge";

const recipeStyles = stylex.create({
  mergeGameDiv: {
    position: "absolute",
    inset: "0",
    display: "grid",
    placeItems: "center",
    backgroundColor: {
      default: "var(--color-lcd-panel)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-lcd-paper) 80%, transparent)",
    },
    textAlign: "center",
  },
});

const variantStyles = stylex.create({
  mergeGameDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingTop: "calc(var(--spacing) * 2)",
  },
});

const viewStyles = stylex.create({
  mergeGameDiv: {
    display: "flex",
    width: "100%",
    paddingInline: "var(--spacing)",
  },
  mergeGameSpan: {
    marginLeft: "auto",
    fontVariantNumeric: "tabular-nums",
  },
  mergeGameSpan2: {
    fontVariantNumeric: "tabular-nums",
  },
  mergeGameSpan3: {
    marginLeft: "auto",
  },
  mergeBoard: {
    position: "relative",
    display: "grid",
    flexShrink: "0",
    touchAction: "none",
  },
  mergeGameDiv2: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  mergeGameSpan4: {
    lineHeight: "14px",
  },
  mergeGameDiv3: {
    display: "flex",
    gap: "calc(var(--spacing) * .5)",
  },
  mergeGameP: {
    marginTop: "auto",
    marginBottom: "var(--spacing)",
    textAlign: "center",
    lineHeight: "1.625",
  },
});

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
    <div {...stylex.attrs(variantStyles.mergeGameDiv)}>
      <div {...stylex.attrs(viewStyles.mergeGameDiv)}>
        <span>{t("web.farm.phone.game.merge")}</span>
        <span {...stylex.attrs(viewStyles.mergeGameSpan)}>
          {t("web.farm.phone.blocks.best")} {Math.max(top(), score())}
        </span>
      </div>
      <div {...stylex.attrs(viewStyles.mergeGameDiv)}>
        <span {...stylex.attrs(viewStyles.mergeGameSpan2)}>
          {t("web.farm.phone.blocks.score")} {score()}
        </span>
        <span {...stylex.attrs(viewStyles.mergeGameSpan3)}>
          {reached() !== 0 ? t("web.farm.phone.merge.reached", { stage: mergeStageName(reached()) }) : ""}
        </span>
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
        {...stylex.attrs(viewStyles.mergeBoard)}
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
              {...stylex.attrs(viewStyles.mergeGameDiv2)}
              style={{
                background: stage() !== 0 ? lcd.paper : lcd.light,
                "box-shadow": g()?.grown.includes(i) === true ? `inset 0 0 0 2px ${lcd.ink}` : undefined,
              }}
            >
              <Show when={stage() > 0}>
                <Crop stage={stage()} size={36} />
                <span {...stylex.attrs(viewStyles.mergeGameSpan4)}>{mergeStageName(stage())}</span>
              </Show>
            </div>
          )}
        </For>
        <Show when={overlay()}>
          {(o) => (
            <div {...stylex.attrs(recipeStyles.mergeGameDiv)}>
              <span>
                {o()[0]}
                <br />
                <span class="phone-blink">{o()[1]}</span>
              </span>
            </div>
          )}
        </Show>
      </div>
      <div {...stylex.attrs(viewStyles.mergeGameDiv3)} aria-label={t("web.farm.phone.merge.stages")}>
        <For each={mergeStages}>
          {(name, i) => (
            <span title={name}>
              <Crop stage={i() + 1} size={24} faint={i() + 1 > reached()} />
            </span>
          )}
        </For>
      </div>
      <p {...stylex.attrs(viewStyles.mergeGameP)} style={{ color: lcd.dark }}>
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
