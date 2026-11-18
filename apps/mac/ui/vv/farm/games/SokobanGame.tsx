import { Canvas, Path2D, View, type CanvasRenderingContext2D } from "nsh";

import { t } from "@vibevalley/i18n";

import { playSound } from "../../web/ui/pixel/sound";
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
    ctx.scale(scale, scale);
    for (const [y, row] of level().rows.entries())
      for (const [x, tile] of [...row].entries()) {
        const id = y * width() + x;
        ctx.save();
        ctx.translate(x * 16, y * 16);
        ctx.fillStyle = tile === "#" ? lcd.dark : lcd.light;
        ctx.fillRect(0, 0, 16, 16);
        if (tile === "#") {
          ctx.strokeStyle = lcd.ink;
          ctx.stroke(new Path2D("M0 7.5h16M7.5 0v7M3.5 8v8"));
        } else {
          ctx.fillStyle = lcd.paper;
          ctx.fillRect(1, 1, 14, 14);
        }
        if (tile === ".") {
          ctx.fillStyle = lcd.mid;
          ctx.fill(new Path2D("M8 4l4 4-4 4-4-4z"));
        }
        if (g().boxes.includes(id)) {
          ctx.fillStyle = tile === "." ? lcd.mid : lcd.dark;
          ctx.fillRect(2.5, 2.5, 11, 11);
          ctx.strokeStyle = lcd.ink;
          ctx.strokeRect(2.5, 2.5, 11, 11);
          ctx.strokeStyle = lcd.paper;
          ctx.stroke(new Path2D("M4 4l8 8m0-8l-8 8"));
          if (tile === ".") {
            ctx.fillStyle = lcd.ink;
            ctx.fillRect(6, 6, 4, 4);
          }
        }
        if (g().player === id) {
          ctx.fillStyle = lcd.ink;
          ctx.fill(new Path2D("M5 2h6v3H3v2h10V5h-2M5 8h6v5H5zM4 13h3v2H4zm5 0h3v2H9z"));
          ctx.fillStyle = lcd.paper;
          ctx.fillRect(6, 5, 4, 3);
        }
        ctx.restore();
      }
  };
  return (
    <View testID="sokoban" style={{ flex: 1, paddingHorizontal: 12, paddingVertical: 8, gap: 8 }}>
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
        style={{ alignSelf: "center", width: 224, height: (224 * level().rows.length) / width() }}
        draw={draw}
      />
      <Words align="center">{t(done() ? (last() ? "web.farm.phone.sokoban.allIn" : "web.farm.phone.sokoban.done") : "web.farm.phone.sokoban.goal")}</Words>
      <View style={{ flex: 1 }} />
      <View style={{ flexDirection: "row", gap: 12, justifyContent: "center" }}>
        <View
          role="button"
          testID="sokoban-undo"
          onPress={undo}
          disabled={g().history.length === 0}
          style={{ opacity: g().history.length ? 1 : 0.4, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: lcd.ink }}
        >
          <Words>{t("web.farm.phone.sokoban.undo")}</Words>
        </View>
        <View
          role="button"
          testID="sokoban-reset"
          onPress={() => (done() ? advance() : restart())}
          style={{ paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: lcd.ink }}
        >
          <Words>A {t(done() ? (last() ? "web.farm.phone.sokoban.again" : "web.farm.phone.sokoban.next") : "web.farm.phone.sokoban.restart")}</Words>
        </View>
      </View>
      <Words dim align="center">
        {t("web.farm.phone.sokoban.help")}
      </Words>
    </View>
  );
}
