import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { phoneAnimations } from "#/farm/interaction.stylex.ts";
import { lcd } from "#/farm/phone/lcd.ts";
import { kept, usePad, useTicks } from "#/farm/phone/pad.ts";
import { playSound } from "#/ui/pixel/sound.ts";
import { styleProps } from "#/ui/positioner.ts";

import { type Blocks, blocksHeight, blocksWidth, cellsOf, fall, fallMs, landingOf, newBlocks, type PieceKind, pieceKinds, shift, slam, turn } from "./blocks";

const recipeStyles = stylex.create({
  blocksGameDiv: {
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
  blocksGameDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingTop: "calc(var(--spacing) * 2)",
  },
  blocksGameDivVariant: {
    gap: "calc(var(--spacing) * 4)",
  },
  blocksGameDivVariant2: {
    gap: "calc(var(--spacing) * 2)",
  },
  blocksGameDiv2: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
});

const viewStyles = stylex.create({
  blocksGameDiv: {
    position: "relative",
    flexShrink: "0",
    alignSelf: "flex-start",
  },
  blocksGameCanvas: {
    display: "block",
    imageRendering: "pixelated",
  },
  blocksGameP: {
    marginTop: "auto",
    marginBottom: "var(--spacing)",
    lineHeight: "1.625",
  },
  nextSvg: {
    marginTop: "var(--spacing)",
    display: "block",
    padding: "var(--spacing)",
  },
  statDiv: {
    display: "flex",
  },
  statSpan: {
    marginLeft: "auto",
    fontVariantNumeric: "tabular-nums",
  },
});

const game = kept<Blocks | undefined>(undefined);
const best = kept(0);

const cellSmall = 9;
const cellBig = 14;

/** The light ones get an inner square, so they read on the screen. */
const shade = [lcd.dark, lcd.ink, lcd.dark, lcd.mid, lcd.ink, lcd.mid, lcd.dark];

export function BlocksGame(props: { big?: boolean }) {
  const cell = () => (props.big === true ? cellBig : cellSmall);
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
    if (next.over && was?.over !== true) {
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
      const block = (x: number, y: number, fill: string | undefined) => {
        if (y < 0) return;
        const px = x * size;
        const py = y * size;
        if (fill === undefined) {
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
      state.well.forEach((c, i) => c !== 0 && block(i % blocksWidth, Math.floor(i / blocksWidth), shade[c - 1]));
      if (!state.over) {
        for (const [x, y] of cellsOf(landingOf(state))) block(x, y, undefined);
        for (const [x, y] of cellsOf(state.piece)) block(x, y, shade[pieceKinds.indexOf(state.piece.kind)]);
      }
    },
  );

  return (
    <div
      data-testid="blocks"
      data-state={!g() ? "ready" : g()!.over ? "over" : playing() ? "playing" : "paused"}
      {...stylex.attrs(variantStyles.blocksGameDiv, props.big === true ? variantStyles.blocksGameDivVariant : variantStyles.blocksGameDivVariant2)}
    >
      <div {...stylex.attrs(viewStyles.blocksGameDiv)} style={{ "box-shadow": `0 0 0 2px ${lcd.ink}` }}>
        <canvas
          ref={(el) => (canvas = el)}
          width={blocksWidth * cell()}
          height={blocksHeight * cell()}
          {...stylex.attrs(viewStyles.blocksGameCanvas)}
          aria-label={t("web.farm.phone.blocks.well")}
          role="img"
        />
        <Show when={!g() || g()!.over || !playing()}>
          <div {...stylex.attrs(recipeStyles.blocksGameDiv)}>
            <span>
              {g()?.over === true ? t("web.farm.phone.blocks.noRoom") : g() ? t("web.farm.phone.paused") : t("web.farm.phone.game.blocks")}
              <br />
              <span {...styleProps(phoneAnimations.blink)}>
                {t("web.farm.phone.pressA", { what: g() && !g()!.over ? t("web.farm.phone.resume") : t("web.farm.phone.start") })}
              </span>
            </span>
          </div>
        </Show>
      </div>
      <div {...stylex.attrs(variantStyles.blocksGameDiv2)}>
        <Next kind={g()?.next} />
        <Stat label={t("web.farm.phone.blocks.score")} value={g()?.score ?? 0} />
        <Stat label={t("web.farm.phone.blocks.lines")} value={g()?.lines ?? 0} />
        <Stat label={t("web.farm.phone.blocks.level")} value={g()?.level ?? 1} />
        <Stat label={t("web.farm.phone.blocks.best")} value={Math.max(top(), g()?.score ?? 0)} />
        <p {...stylex.attrs(viewStyles.blocksGameP)} style={{ color: lcd.dark }}>
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
      <svg
        width={36}
        height={20}
        viewBox="0 0 4 2"
        shape-rendering="crispEdges"
        {...stylex.attrs(viewStyles.nextSvg)}
        style={{ background: lcd.light }}
        aria-hidden="true"
      >
        <For each={cells()}>{([x, y]) => <rect x={x} y={y === 0 ? 0 : 1} width={0.9} height={0.9} fill={lcd.ink} />}</For>
      </svg>
    </div>
  );
}

function Stat(props: { label: string; value: number }) {
  return (
    <div {...stylex.attrs(viewStyles.statDiv)}>
      <span>{props.label}</span>
      <span {...stylex.attrs(viewStyles.statSpan)}>{props.value}</span>
    </div>
  );
}
