import { Canvas, View, type CanvasRenderingContext2D } from "nsh";

import { t } from "@vibevalley/i18n";

import { playSound } from "../../design/pixel/sound";
import { lcd } from "./lcd";
import { Words, Stats } from "./LcdView";
import { kept, usePad } from "./pad";
import { moveWarehouse, newWarehouse, undoWarehouse, warehouseDone, warehouses } from "./sokoban";

const warehouse = kept(newWarehouse());

export function SokobanGame() {
  const [g, setG] = warehouse.use();
  const done = () => warehouseDone(g());
  const last = () => g().level === warehouses.length - 1;
  const level = () => warehouses[g().level] ?? warehouses[0];
  const width = () => level().rows[0].length;
  const cells = () => level().rows.join("");
  const placed = () => g().boxes.filter((p) => cells()[p] === ".").length;
  const restart = () => setG(newWarehouse(warehouse.get().level));
  const advance = () => {
    const now = warehouse.get();
    setG(newWarehouse(now.level === warehouses.length - 1 ? 0 : now.level + 1));
  };
  const undo = () => setG(undoWarehouse(warehouse.get()));

  usePad((button, down) => {
    if (!down) return;
    const now = warehouse.get();
    switch (button) {
      case "a":
        return warehouseDone(now) ? advance() : restart();
      case "b":
        return undo();
      case "left":
      case "right":
      case "up":
      case "down": {
        const next = moveWarehouse(now, button);
        if (next === now) return;
        if (warehouseDone(next)) playSound("coin");
        else if (next.pushes > now.pushes) playSound("thud");
        setG(next);
      }
    }
  });

  const draw = (ctx: CanvasRenderingContext2D) => {
    const scale = 224 / (width() * 16);
    for (const [y, row] of level().rows.entries()) {
      for (const [x, tile] of [...row].entries()) {
        const id = y * width() + x;
        const px = (u: number) => Math.round((x * 16 + u) * scale);
        const py = (v: number) => Math.round((y * 16 + v) * scale);
        const rect = (left: number, top: number, w: number, h: number, fill: string) => {
          ctx.fillStyle = fill;
          ctx.fillRect(px(left), py(top), px(left + w) - px(left), py(top + h) - py(top));
        };
        // The SVG board uses crispEdges, including diagonal shapes on a fractional cell scale.
        const raster = (fill: string, contains: (u: number, v: number) => boolean) => {
          ctx.fillStyle = fill;
          for (let row = py(0); row < py(16); row++) {
            const v = (row + 0.5) / scale - 16 * y;
            let start: number | undefined;
            for (let col = px(0); col <= px(16); col++) {
              const inside = col < px(16) && contains((col + 0.5) / scale - 16 * x, v);
              if (inside && start === undefined) start = col;
              if (!inside && start !== undefined) {
                ctx.fillRect(start, row, col - start, 1);
                start = undefined;
              }
            }
          }
        };
        rect(0, 0, 16, 16, tile === "#" ? lcd.dark : lcd.light);
        if (tile === "#") {
          rect(0, 7, 16, 1, lcd.ink);
          rect(7, 0, 1, 7, lcd.ink);
          rect(3, 8, 1, 8, lcd.ink);
        } else {
          rect(1, 1, 14, 14, lcd.paper);
        }
        if (tile === ".") raster(lcd.mid, (u, v) => Math.abs(u - 8) + Math.abs(v - 8) <= 4);
        if (g().boxes.includes(id)) {
          rect(2, 2, 12, 12, lcd.ink);
          rect(3, 3, 10, 10, tile === "." ? lcd.mid : lcd.dark);
          raster(
            lcd.paper,
            (u, v) => (u + v >= 8 && u + v <= 24 && Math.abs(u - v) <= Math.SQRT1_2) || (Math.abs(u + v - 16) <= Math.SQRT1_2 && Math.abs(u - v) <= 8),
          );
          if (tile === ".") rect(6, 6, 4, 4, lcd.ink);
        }
        if (g().player === id) {
          rect(5, 2, 6, 3, lcd.ink);
          rect(3, 5, 10, 2, lcd.ink);
          rect(5, 8, 6, 5, lcd.ink);
          rect(4, 13, 3, 2, lcd.ink);
          rect(9, 13, 3, 2, lcd.ink);
          rect(6, 5, 4, 3, lcd.paper);
        }
      }
    }
  };
  return (
    <View testID="sokoban" class="flex-1 gap-2 px-3 py-2">
      <Stats
        label={t("web.farm.phone.sokoban.title", { level: g().level + 1, of: warehouses.length })}
        value={t("web.farm.phone.sokoban.moves", { moves: g().moves, pushes: g().pushes })}
      />
      <Words align="center">{level().name}</Words>
      <Canvas
        accessible
        role="image"
        testID="sokoban-board"
        accessibilityLabel={t("web.farm.phone.sokoban.board", { placed: placed(), of: g().boxes.length })}
        class="w-56 self-center"
        style={{ height: (224 * level().rows.length) / width() }}
        draw={draw}
      />
      <Words align="center">{t(done() ? (last() ? "web.farm.phone.sokoban.allIn" : "web.farm.phone.sokoban.done") : "web.farm.phone.sokoban.goal")}</Words>
      <View class="flex-1" />
      <View class="flex-row justify-center gap-3">
        <View
          role="button"
          testID="sokoban-undo"
          onPress={undo}
          disabled={g().history.length === 0}
          class={`border border-lcd-ink px-2 py-1 ${g().history.length > 0 ? "opacity-100" : "opacity-40"}`}
        >
          <Words>{t("web.farm.phone.sokoban.undo")}</Words>
        </View>
        <View role="button" testID="sokoban-reset" onPress={() => (done() ? advance() : restart())} class="border border-lcd-ink px-2 py-1">
          <Words>A {t(done() ? (last() ? "web.farm.phone.sokoban.again" : "web.farm.phone.sokoban.next") : "web.farm.phone.sokoban.restart")}</Words>
        </View>
      </View>
      <Words dim align="center">
        {t("web.farm.phone.sokoban.help")}
      </Words>
    </View>
  );
}
