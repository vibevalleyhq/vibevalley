import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { phoneAnimations } from "#/farm/interaction.stylex.ts";
import { drawPattern, lcd } from "#/farm/phone/lcd.ts";
import { kept, usePad, useTicks } from "#/farm/phone/pad.ts";
import { playSound } from "#/ui/pixel/sound.ts";
import { styleProps } from "#/ui/positioner.ts";

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

const styles = stylex.create({
  overlay: {
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
  root: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
    alignItems: "center",
    paddingInline: "0.25rem",
    paddingTop: "0.75rem",
  },
  topRow: {
    display: "flex",
    width: "100%",
    paddingInline: "0.5rem",
  },
  bestScore: {
    marginLeft: "auto",
    fontVariantNumeric: "tabular-nums",
  },
  subRow: {
    marginTop: "0.25rem",
    display: "flex",
    width: "100%",
    paddingInline: "0.5rem",
    fontVariantNumeric: "tabular-nums",
  },
  score: {
    marginLeft: "auto",
  },
  fieldFrame: {
    position: "relative",
    marginTop: "0.5rem",
    boxShadow: "0 0 0 2px var(--color-lcd-ink)",
  },
  canvas: {
    display: "block",
    width: width * zoom,
    height: height * zoom,
    imageRendering: "pixelated",
  },
  help: {
    marginTop: "auto",
    marginBottom: "0.5rem",
    textAlign: "center",
    lineHeight: "1.625",
    color: "var(--color-lcd-dark)",
  },
});

const game = kept<BugSnake | undefined>(undefined);
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
    if (state.bug !== undefined && (state.bugLeft > 10 || Math.floor(state.bugLeft / 2) % 2 === 0)) draw(state.bugLeft % 2 === 0 ? bug[0] : bug[1], state.bug);
    state.body.forEach((c, i) => draw(i === 0 ? heads[state.heading] : i === state.body.length - 1 ? tail : i % 2 === 0 ? segment[0] : segment[1], c));
  });

  const score = () => g()?.score ?? 0;
  return (
    <div {...stylex.attrs(styles.root)}>
      <div {...stylex.attrs(styles.topRow)}>
        <span>{t("web.farm.phone.game.bugs")}</span>
        <span {...stylex.attrs(styles.bestScore)}>
          {t("web.farm.phone.blocks.best")} {five(Math.max(top(), score()))}
        </span>
      </div>
      <div {...stylex.attrs(styles.subRow)}>
        <span>{t("web.farm.phone.bugs.tally", { seeds: g()?.eaten ?? 0, bugs: g()?.bugs ?? 0 })}</span>
        <span {...stylex.attrs(styles.score)}>{five(score())}</span>
      </div>
      <div {...stylex.attrs(styles.fieldFrame)}>
        <canvas
          ref={(el) => (canvas = el)}
          width={width}
          height={height}
          role="img"
          aria-label={t("web.farm.phone.bugs.field")}
          {...stylex.attrs(styles.canvas)}
        />
        <Show when={!g() || g()?.over !== undefined || !playing()}>
          <div {...stylex.attrs(styles.overlay)}>
            <span>
              {(() => {
                const over = g()?.over;
                return over ? ended[over] : g() ? t("web.farm.phone.paused") : t("web.farm.phone.game.bugs");
              })()}
              <br />
              <span {...styleProps(phoneAnimations.blink)}>
                {t("web.farm.phone.pressA", {
                  what: g() && g()?.over === undefined ? t("web.farm.phone.resume") : g() ? t("web.farm.phone.again") : t("web.farm.phone.start"),
                })}
              </span>
            </span>
          </div>
        </Show>
      </div>
      <p {...stylex.attrs(styles.help)}>
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
