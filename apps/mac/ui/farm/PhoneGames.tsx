import { Canvas, Text, View, signal } from "nsh";

import { t } from "@vibevalley/i18n";

import { Keyed } from "../infra/base/dom";
import { BlocksGame } from "./games/BlocksGame";
import { BugSnakeGame } from "./games/BugSnakeGame";
import { DinoGame } from "./games/DinoGame";
import { lcd } from "./games/lcd";
import { MergeGame } from "./games/MergeGame";
import { press, type PadButton } from "./games/pad";
import { SokobanGame } from "./games/SokobanGame";

export type GameId = "blocks" | "sokoban" | "dino" | "bugs" | "merge";

export function PhoneGame(props: { id: GameId; onBack: () => void }) {
  return (
    <Keyed key={props.id}>
      {() => {
        switch (props.id) {
          case "blocks":
            return <BlocksGame big />;
          case "sokoban":
            return <SokobanGame />;
          case "dino":
            return <DinoGame big />;
          case "bugs":
            return <BugSnakeGame />;
          case "merge":
            return <MergeGame />;
        }
      }}
    </Keyed>
  );
}

const cross = { up: [16, 0], left: [0, 16], right: [32, 16], down: [16, 32] } as const;
function PadKey(props: { button: PadButton }) {
  const held = signal(false);
  const toggle = (down: boolean) => {
    if (held() !== down) {
      held.set(down);
      press(props.button, down);
    }
  };
  const label = () => (props.button === "a" || props.button === "b" ? props.button.toUpperCase() : t(`web.farm.phone.key.${props.button}`));
  const side = () => (props.button === "a" || props.button === "b" ? undefined : cross[props.button]);
  return (
    <View
      role="button"
      testID={`pad-${props.button}`}
      accessibilityLabel={label()}
      onPressDown={() => toggle(true)}
      onPressUp={() => toggle(false)}
      onMouseLeave={() => toggle(false)}
      class={
        side()
          ? `absolute h-4 w-4 ${held() ? "bg-bark-950" : "bg-bark-900"}`
          : `h-6 w-6 items-center justify-center border-2 border-bark-900 bg-berry-500 ${held() ? "top-[1px]" : "top-0"}`
      }
      style={side() ? { left: side()?.[0], top: side()?.[1] } : undefined}
    >
      <If when={!side()}>
        <Text class="font-pixel text-xs text-cream-50">{props.button.toUpperCase()}</Text>
      </If>
    </View>
  );
}
export function GamePad() {
  return (
    <View testID="pad" class="mt-2 flex-row items-center justify-between px-1">
      <View class="relative h-12 w-12">
        <View class="absolute top-4 left-4 h-4 w-4 bg-bark-900" />
        <PadKey button="up" />
        <PadKey button="down" />
        <PadKey button="left" />
        <PadKey button="right" />
      </View>
      <View class="flex-row gap-2">
        <PadKey button="b" />
        <PadKey button="a" />
      </View>
    </View>
  );
}

export function GameIcon(props: { id: GameId; size?: number }) {
  const size = () => props.size ?? 28;
  return (
    <Canvas
      style={{ width: size(), height: size() }}
      draw={(cx) => {
        const rect = (x: number, y: number, w: number, h: number, c: string) => {
          cx.fillStyle = c;
          cx.fillRect(x, y, w, h);
        };
        const pixels = (lines: readonly string[], palette: Record<string, string>, x = 0, y = 0) => {
          lines.forEach((row, dy) =>
            [...row].forEach((c, dx) => {
              const fill = palette[c];
              if (fill) rect(x + dx, y + dy, 1, 1, fill);
            }),
          );
        };
        switch (props.id) {
          case "blocks":
            cx.scale(size() / 7, size() / 7);
            rect(0, 5, 7, 2, lcd.dark);
            rect(1, 4, 2, 1, lcd.dark);
            rect(2, 1, 3, 1, lcd.ink);
            rect(3, 2, 1, 1, lcd.ink);
            rect(5, 4, 1, 1, lcd.mid);
            rect(4, 5, 1, 1, lcd.paper);
            break;
          case "dino":
            cx.scale(size() / 10, size() / 10);
            pixels(["  ####", " ## ##", " #####", " ##   ", "####  ", "##### ", " ###  ", " # #  "], { "#": lcd.ink }, 2, 1);
            rect(1, 9, 8, 1, lcd.dark);
            break;
          case "sokoban":
            cx.strokeStyle = lcd.ink;
            cx.lineWidth = 2;
            cx.strokeRect(1, 1, size() - 2, size() - 2);
            cx.beginPath();
            cx.moveTo(10, 10);
            cx.lineTo(18, 18);
            cx.moveTo(18, 10);
            cx.lineTo(10, 18);
            cx.stroke();
            break;
          case "bugs":
            cx.scale(size() / 10, size() / 10);
            pixels(["    # #   ", "    ###   ", "++..#o#  #", "++..###  +"], { "#": lcd.ink, "+": lcd.dark, ".": lcd.mid, o: lcd.paper }, 0, 3);
            rect(0, 7, 10, 1, lcd.dark);
            break;
          case "merge":
            cx.scale(size() / 13, size() / 13);
            [
              ["    ", " ## ", " ## ", "    "],
              ["#  #", " ## ", " #  ", " #  "],
              [" ## ", "#  #", " ## ", "  # "],
              ["# # ", "# # ", "+ + ", "+ + "],
            ].forEach((rows, n) => {
              const x = (n % 2) * 7,
                y = Math.floor(n / 2) * 7;
              rect(x, y, 6, 6, lcd.dark);
              rect(x + 1, y + 1, 4, 4, lcd.paper);
              pixels(rows, { "#": lcd.ink, "+": lcd.dark }, x + 1, y + 1);
            });
            break;
        }
      }}
    />
  );
}
