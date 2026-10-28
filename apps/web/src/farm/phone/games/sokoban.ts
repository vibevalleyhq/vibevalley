import { t } from "@vibevalley/i18n";
// 推箱子: push the crates of harvest onto the marks; every step can be taken back.

export interface Warehouse {
  readonly name: string;
  /** `#` wall, `.` goal, `$` box, `@` the player, space floor; every row the same length. */
  readonly rows: readonly string[];
}

export const warehouses: readonly Warehouse[] = [
  { name: t("web.farm.phone.sokoban.levels.0"), rows: ["######", "#    #", "#@$. #", "#    #", "######"] },
  { name: t("web.farm.phone.sokoban.levels.1"), rows: ["#######", "#     #", "# .$  #", "#  #@ #", "#     #", "#######"] },
  { name: t("web.farm.phone.sokoban.levels.2"), rows: ["#######", "# . . #", "# $ $ #", "#  @  #", "#     #", "#######"] },
  { name: t("web.farm.phone.sokoban.levels.3"), rows: ["#######", "# .   #", "# $   #", "#   $ #", "# # . #", "#  @  #", "#######"] },
  { name: t("web.farm.phone.sokoban.levels.4"), rows: ["########", "# . . .#", "# $ $ $#", "#      #", "#  @   #", "########"] },
];

export type WarehouseDirection = "left" | "right" | "up" | "down";

/** Cells are indexes into the warehouse's rows joined. */
export interface WarehousePosition {
  readonly player: number;
  readonly boxes: readonly number[];
  readonly moves: number;
  readonly pushes: number;
}

export interface WarehouseGame extends WarehousePosition {
  readonly level: number;
  readonly history: readonly WarehousePosition[];
}

const cellsOf = (level: number) => warehouses[level]!.rows.join("");

export function newWarehouse(level = 0): WarehouseGame {
  const chosen = level >= 0 && level < warehouses.length ? level : 0;
  const cells = cellsOf(chosen);
  return { level: chosen, player: cells.indexOf("@"), boxes: [...cells].flatMap((c, i) => (c === "$" ? [i] : [])), moves: 0, pushes: 0, history: [] };
}

export const warehouseDone = (g: WarehouseGame) => {
  const cells = cellsOf(g.level);
  return g.boxes.every((box) => cells[box] === ".");
};

/** `g` itself when nothing moves. */
export function moveWarehouse(g: WarehouseGame, direction: WarehouseDirection): WarehouseGame {
  if (warehouseDone(g)) return g;
  const rows = warehouses[g.level]!.rows;
  const width = rows[0]!.length;
  const cells = rows.join("");
  const offset = direction === "left" ? -1 : direction === "right" ? 1 : direction === "up" ? -width : width;
  const step = (from: number): number | undefined => {
    const next = from + offset;
    if (next < 0 || next >= cells.length || cells[next] === "#") return undefined;
    if ((direction === "left" || direction === "right") && Math.floor(from / width) !== Math.floor(next / width)) return undefined;
    return next;
  };
  const player = step(g.player);
  if (player === undefined) return g;
  const box = g.boxes.indexOf(player);
  let boxes = g.boxes;
  if (box >= 0) {
    const target = step(player);
    if (target === undefined || g.boxes.includes(target)) return g;
    boxes = g.boxes.map((b, i) => (i === box ? target : b));
  }
  const previous: WarehousePosition = { player: g.player, boxes: g.boxes, moves: g.moves, pushes: g.pushes };
  return { level: g.level, player, boxes, moves: g.moves + 1, pushes: g.pushes + (box < 0 ? 0 : 1), history: [...g.history, previous] };
}

export function undoWarehouse(g: WarehouseGame): WarehouseGame {
  const p = g.history.at(-1);
  if (!p) return g;
  return { level: g.level, ...p, history: g.history.slice(0, -1) };
}
