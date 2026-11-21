import { Canvas, View, type CanvasRenderingContext2D } from "nsh";

import { t } from "@vibevalley/i18n";

import { playSound } from "../../design/pixel/sound";
import { createSignal } from "../../infra/solid";
import { type Blocks, blocksHeight, blocksWidth, cellsOf, fall, fallMs, landingOf, newBlocks, pieceKinds, shift, slam, turn } from "./blocks";
import { lcd } from "./lcd";
import { Board, Cover, Help, Words, Stats } from "./LcdView";
import { kept, usePad, useTicks } from "./pad";

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
    () => playing() && !!g() && g()?.over !== true,
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

  const draw = (ctx: CanvasRenderingContext2D) => {
    const state = g();
    const size = cell();
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
  };
  return (
    <View testID="blocks" class="flex-1 flex-row items-start gap-4 px-2 pt-2">
      <Board label={t("web.farm.phone.blocks.well")} width={cell() * blocksWidth} height={cell() * blocksHeight} draw={draw}>
        <If when={!playing() || g()?.over === true}>
          <Cover
            lines={[
              t(g()?.over === true ? "web.farm.phone.blocks.noRoom" : g() ? "web.farm.phone.paused" : "web.farm.phone.game.blocks"),
              t("web.farm.phone.pressA", { what: t(g() && g()?.over !== true ? "web.farm.phone.resume" : "web.farm.phone.start") }),
            ]}
          />
        </If>
      </Board>
      <View class="h-full flex-1 gap-2">
        <Words>{t("web.farm.phone.blocks.next")}</Words>
        <Canvas
          class="h-5 w-9 bg-lcd-light"
          draw={(cx) => {
            const kind = g()?.next;
            if (kind) {
              cx.fillStyle = lcd.ink;
              for (const [x, y] of cellsOf({ kind, turn: 0, x: 0, y: 0 })) cx.fillRect(4 + x * 7, 4 + Math.min(y, 1) * 6, 6, 5);
            }
          }}
        />
        <Stats label={t("web.farm.phone.blocks.score")} value={g()?.score ?? 0} />
        <Stats label={t("web.farm.phone.blocks.lines")} value={g()?.lines ?? 0} />
        <Stats label={t("web.farm.phone.blocks.level")} value={g()?.level ?? 1} />
        <Stats label={t("web.farm.phone.blocks.best")} value={Math.max(top(), g()?.score ?? 0)} />
        <Help lines={[t("web.farm.phone.blocks.help"), t("web.farm.phone.blocks.help2"), t("web.farm.phone.blocks.help3")]} />
      </View>
    </View>
  );
}
