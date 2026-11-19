import { View, type CanvasRenderingContext2D } from "nsh";

import { t } from "@vibevalley/i18n";

import { createSignal } from "../../solid";
import { playSound } from "../../web/ui/pixel/sound";
import { type Dino, dinoBox, dinoGround, dinoHeight, dinoScore, dinoWidth, duck, jump, newDino, type Obstacle, run } from "./dino";
import { lcd, drawPattern } from "./lcd";
import { Board, Cover, Help, Words, Stats } from "./LcdView";
import { kept, usePad, useTicks } from "./pad";

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

const picture = (o: Obstacle, t: number): readonly string[] =>
  o.kind === "bird" ? (Math.floor(t / 180) % 2 === 0 ? bird[0] : bird[1]) : o.kind === "cactus" ? cactus : cacti;

const five = (n: number) => String(n).padStart(5, "0");

export function DinoGame(props: { big?: boolean }) {
  const zoom = () => (props.big === true ? 3 : 2);
  const [d, setD] = createSignal<Dino>();
  const [top, setTop] = best.use();
  const playing = () => !!d() && d()?.over !== true;

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

  const draw = (ctx: CanvasRenderingContext2D) => {
    const state = d();
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
    drawPattern(ctx, ducking ? (frame === 0 ? duckFrames[0] : duckFrames[1]) : run0.lift > 0 || frame === 0 ? runFrames[0] : runFrames[1], box.x, box.y);
  };
  const score = () => {
    const now = d();
    return now ? dinoScore(now) : 0;
  };
  return (
    <View testID="dino" style={{ flex: 1, alignItems: "center", paddingHorizontal: 4, paddingTop: 12 }}>
      <Stats label={t("web.farm.phone.game.dino")} value={t("web.farm.phone.blocks.best") + " " + five(Math.max(score(), top()))} />
      <View style={{ alignSelf: "flex-end", marginTop: 4, marginBottom: 8 }}>
        <Words>{five(score())}</Words>
      </View>
      <Board label={t("web.farm.phone.dino.road")} width={dinoWidth} height={dinoHeight} zoom={zoom()} draw={draw}>
        <If when={!playing()}>
          <Cover
            solid
            lines={[
              (d()?.over ? t("web.farm.phone.dino.crashed") : t("web.farm.phone.game.dino")) +
                " · " +
                t("web.farm.phone.pressA", { what: t(d()?.over ? "web.farm.phone.again" : "web.farm.phone.start") }),
            ]}
          />
        </If>
      </Board>
      <Help lines={[t("web.farm.phone.dino.help"), t("web.farm.phone.dino.help2")]} />
    </View>
  );
}
