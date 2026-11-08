import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { drawPattern, lcd } from "#/farm/phone/lcd.ts";
import { kept, usePad, useTicks } from "#/farm/phone/pad.ts";
import { playSound } from "#/ui/pixel/sound.ts";

import { type Dino, dinoBox, dinoGround, dinoHeight, dinoScore, dinoWidth, duck, jump, newDino, type Obstacle, run } from "./dino";

const variantStyles = stylex.create({
  dinoGameDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
    alignItems: "center",
    paddingInline: "var(--spacing)",
    paddingTop: "calc(var(--spacing) * 3)",
  },
});

const viewStyles = stylex.create({
  dinoGameDiv: {
    display: "flex",
    width: "100%",
    paddingInline: "var(--spacing)",
  },
  dinoGameSpan: {
    marginLeft: "auto",
    fontVariantNumeric: "tabular-nums",
  },
  dinoGameDiv2: {
    marginTop: "var(--spacing)",
    width: "100%",
    paddingInline: "var(--spacing)",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  },
  dinoGameDiv3: {
    position: "relative",
    marginTop: "calc(var(--spacing) * 2)",
  },
  dinoGameCanvas: {
    display: "block",
    imageRendering: "pixelated",
  },
  dinoGameDiv4: {
    position: "absolute",
    inset: "0",
    display: "grid",
    placeItems: "center",
    textAlign: "center",
  },
  dinoGameSpan2: {
    paddingInline: "calc(var(--spacing) * 2)",
  },
  dinoGameP: {
    marginTop: "auto",
    marginBottom: "calc(var(--spacing) * 2)",
    textAlign: "center",
    lineHeight: "1.625",
  },
});

const best = kept(0);

/** 12×14, two running frames; ducking, 16×8. */
const runFrames = [
  [
    "      ####  ",
    "     ## ### ",
    "     #######",
    "     ####   ",
    "#    ######",
    "##  #####   ",
    "########### ",
    " #########  ",
    "  ########  ",
    "   ######   ",
    "    ##  #   ",
    "    #   ##  ",
    "    ##      ",
    "            ",
  ],
  [
    "      ####  ",
    "     ## ### ",
    "     #######",
    "     ####   ",
    "#    ######",
    "##  #####   ",
    "########### ",
    " #########  ",
    "  ########  ",
    "   ######   ",
    "    #  ##   ",
    "   ##   #   ",
    "        ##  ",
    "            ",
  ],
] as const;
const duckFrames = [
  [
    "           ##### ",
    "#  ########## ###",
    "############### ",
    " ##########     ",
    "  #######       ",
    "   #  ##        ",
    "   ##  #        ",
    "       ##       ",
  ],
  [
    "           ##### ",
    "#  ########## ###",
    "############### ",
    " ##########     ",
    "  #######       ",
    "   ## #         ",
    "      ##        ",
    "                ",
  ],
] as const;
const cactus = [" ++   ", " ++ + ", "+++ + ", "+++++ ", " ++   ", " ++   ", " ++   ", " ++   ", " ++   ", " ++   ", " ++   ", " ++   "];
const cacti = [
  " +     +    ",
  "+++ + +++   ",
  "+++ +++++ + ",
  "+++++++++++ ",
  "+++ +++++   ",
  "+++++++++   ",
  "+++ ++++++  ",
  "+++ +++++   ",
  "+++ +++++   ",
  "+++ +++++   ",
];
const bird = [
  ["   #        ", "  ###       ", " ###### ##  ", "#########   ", "   ######   ", "    ###     ", "            ", "            "],
  ["            ", "            ", " ###### ##  ", "#########   ", "   ######   ", "    ####    ", "     ##     ", "      #     "],
] as const;

const picture = (o: Obstacle, t: number): readonly string[] => (o.kind === "bird" ? bird[Math.floor(t / 180) % 2]! : o.kind === "cactus" ? cactus : cacti);

const five = (n: number) => String(n).padStart(5, "0");

export function DinoGame(props: { big?: boolean }) {
  const zoom = () => (props.big === true ? 3 : 2);
  const [d, setD] = createSignal<Dino>();
  const [top, setTop] = best.use();
  let canvas: HTMLCanvasElement | undefined;
  const playing = () => !!d() && !d()!.over;

  const start = () => {
    setD(jump(newDino(Math.floor(Math.random() * 2 ** 31))));
    playSound("yip");
  };

  useTicks(playing, (ms) => {
    const now = d();
    if (!now) return;
    const next = run(now, ms);
    if (next.over) {
      playSound("thud");
      if (dinoScore(next) > best.get()) setTop(dinoScore(next));
    }
    setD(next);
  });

  usePad((button, down) => {
    const now = d();
    const jumpKey = button === "a" || button === "up";
    if (!now || now.over) return void (down && jumpKey && start());
    if (jumpKey && down) {
      if (now.lift === 0) playSound("tap");
      setD(jump(now));
      return;
    }
    if (button === "down" || button === "b") setD(duck(now, down));
  });

  createEffect(d, (state) => {
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = lcd.paper;
    ctx.fillRect(0, 0, dinoWidth, dinoHeight);
    const run0 = state ?? newDino(0);
    ctx.fillStyle = lcd.dark;
    ctx.fillRect(0, dinoGround, dinoWidth, 1);
    ctx.fillStyle = lcd.mid;
    const walked = Math.floor(run0.distance);
    for (let x = -(walked % 23); x < dinoWidth; x += 23) ctx.fillRect(x + 4, dinoGround + 3, 2, 1);
    for (let x = -((walked * 2) % 37); x < dinoWidth; x += 37) ctx.fillRect(x + 20, dinoGround + 5, 1, 1);
    for (const o of run0.obstacles) drawPattern(ctx, picture(o, run0.time), o.x, o.y);
    const box = dinoBox(run0);
    const frame = Math.floor(run0.time / 110) % 2;
    const ducking = run0.ducking && run0.lift === 0;
    drawPattern(ctx, ducking ? duckFrames[frame]! : runFrames[run0.lift > 0 ? 0 : frame]!, box.x, box.y);
  });

  const score = () => {
    const now = d();
    return now ? dinoScore(now) : 0;
  };
  return (
    <div {...stylex.attrs(variantStyles.dinoGameDiv)}>
      <div {...stylex.attrs(viewStyles.dinoGameDiv)}>
        <span>{t("web.farm.phone.game.dino")}</span>
        <span {...stylex.attrs(viewStyles.dinoGameSpan)}>
          {t("web.farm.phone.blocks.best")} {five(Math.max(top(), score()))}
        </span>
      </div>
      <div {...stylex.attrs(viewStyles.dinoGameDiv2)}>{five(score())}</div>
      <div {...stylex.attrs(viewStyles.dinoGameDiv3)} style={{ "box-shadow": `0 0 0 2px ${lcd.ink}` }}>
        <canvas
          ref={(el) => (canvas = el)}
          width={dinoWidth}
          height={dinoHeight}
          role="img"
          aria-label={t("web.farm.phone.dino.road")}
          {...stylex.attrs(viewStyles.dinoGameCanvas)}
          style={{ width: `${dinoWidth * zoom()}px`, height: `${dinoHeight * zoom()}px` }}
        />
        <Show when={!playing()}>
          <div {...stylex.attrs(viewStyles.dinoGameDiv4)}>
            <span {...stylex.attrs(viewStyles.dinoGameSpan2)} style={{ background: lcd.paper }}>
              {d()?.over === true ? t("web.farm.phone.dino.crashed") : t("web.farm.phone.game.dino")} ·{" "}
              <span class="phone-blink">
                {t("web.farm.phone.pressA", { what: d()?.over === true ? t("web.farm.phone.again") : t("web.farm.phone.start") })}
              </span>
            </span>
          </div>
        </Show>
      </div>
      <p {...stylex.attrs(viewStyles.dinoGameP)} style={{ color: lcd.dark }}>
        {t("web.farm.phone.dino.help")}
        <br />
        {t("web.farm.phone.dino.help2")}
      </p>
    </div>
  );
}
