// 推箱子, 方块 and 小恐龙: the recorded deals and runs must replay as they were.
import { describe, expect, test } from "vite-plus/test";

import { type Blocks, blocksHeight, blocksWidth, cellsOf, fall, fallMs, newBlocks, type PieceKind, pieceKinds, shift, slam, turn } from "./blocks";
import { type Dino, dinoGround, dinoScore, duck, jump, newDino, type Obstacle, run } from "./dino";
import { moveWarehouse, newWarehouse, undoWarehouse, type WarehouseDirection, type WarehouseGame, warehouseDone, warehouses } from "./sokoban";

const emptyWell = () => Array<number>(blocksWidth * blocksHeight).fill(0);

function dealt(seed: number, n: number): PieceKind[] {
  let g: Blocks = newBlocks(seed);
  const out: PieceKind[] = [];
  for (let i = 0; i < n; i++) {
    out.push(g.piece.kind);
    g = slam({ ...g, well: emptyWell() });
  }
  return out;
}

function runFor(d: Dino, ms: number, step = 16) {
  let x = d;
  for (let t = 0; t < ms; t += step) x = run(x, step);
  return x;
}

const withObstacles = (d: Dino, obstacles: Obstacle[], gap: number): Dino => ({ ...d, obstacles, gap });

describe("推箱子", () => {
  test("walls block movement; a push finishes the first puzzle and undo restores it", () => {
    const g = newWarehouse();
    expect(moveWarehouse(g, "left")).toBe(g);
    const next = moveWarehouse(g, "right");
    expect(warehouseDone(next)).toBe(true);
    expect(next.moves).toBe(1);
    expect(next.pushes).toBe(1);
    expect(moveWarehouse(next, "down")).toBe(next);
    expect(undoWarehouse(next)).toEqual(g);
    expect(undoWarehouse(g)).toBe(g);
    expect(newWarehouse(next.level)).toEqual(g);
  });

  test("boxes cannot be pushed through walls or each other; walking does not push", () => {
    const g = newWarehouse(2);
    const width = warehouses[2]!.rows[0]!.length;
    const blocked: WarehouseGame = { level: 2, player: width + 2, boxes: [width + 1, width + 3, width + 4], moves: 0, pushes: 0, history: [] };
    expect(moveWarehouse(blocked, "left")).toBe(blocked);
    expect(moveWarehouse(blocked, "right")).toBe(blocked);
    const walked = moveWarehouse(g, "down");
    expect(walked.moves).toBe(1);
    expect(walked.pushes).toBe(0);
    expect(undoWarehouse(walked)).toEqual(g);
  });

  test("every authored warehouse is rectangular, enclosed, and solvable", () => {
    warehouses.forEach((w, level) => {
      const rows = w.rows;
      expect(rows.every((r) => r.length === rows[0]!.length)).toBe(true);
      expect([...rows[0]!].every((c) => c === "#")).toBe(true);
      expect([...rows.at(-1)!].every((c) => c === "#")).toBe(true);
      expect(rows.every((r) => r.startsWith("#") && r.endsWith("#"))).toBe(true);
      expect(rows.join("").split("@").length - 1).toBe(1);
      const g = newWarehouse(level);
      expect(g.boxes.length).toBe(rows.join("").split(".").length - 1);
      const key = (s: WarehouseGame) => `${s.player}:${[...s.boxes].toSorted((a, b) => a - b).join(",")}`;
      const queue = [g];
      const seen = new Set([key(g)]);
      let solved = false;
      for (let i = 0; i < queue.length && i < 80000; i++) {
        const current = queue[i]!;
        if (warehouseDone(current)) {
          solved = true;
          break;
        }
        for (const dir of ["left", "right", "up", "down"] as WarehouseDirection[]) {
          const next = moveWarehouse(current, dir);
          if (!seen.has(key(next))) {
            seen.add(key(next));
            queue.push({ ...next, history: [] });
          }
        }
      }
      expect(solved).toBe(true);
    });
  });
});

describe("方块", () => {
  test("a seed replays the recorded deal", () => {
    expect(dealt(42, 14).join("")).toBe("SOIJLTZTJILZSO");
    expect(newBlocks(42).seed).toBe(-1895506968);
    expect(newBlocks(123456789).seed).toBe(-1772050221);
  });

  test("a seed deals the same pieces again; every seven are one of each", () => {
    expect(dealt(42, 14)).toEqual(dealt(42, 14));
    const pieces = dealt(7, 14);
    expect(new Set(pieces.slice(0, 7))).toEqual(new Set(pieceKinds));
    expect(new Set(pieces.slice(7, 14))).toEqual(new Set(pieceKinds));
  });

  test("the walls stop a piece; a turn against a wall is nudged off it", () => {
    let g: Blocks = { ...newBlocks(1), piece: { kind: "T", turn: 0, x: 3, y: 0 } };
    for (let i = 0; i < 20; i++) g = shift(g, -1);
    expect(Math.min(...cellsOf(g.piece).map(([x]) => x))).toBe(0);
    const flat = turn({ ...g, piece: { kind: "I", turn: 1, x: blocksWidth - 3, y: 2 } });
    expect(flat.piece.turn).toBe(2);
    expect(cellsOf(flat.piece).every(([x]) => x < blocksWidth)).toBe(true);
  });

  test("a full row clears, the rows above fall, and it scores by the level", () => {
    const well = emptyWell();
    for (let x = 0; x < blocksWidth - 4; x++) well[(blocksHeight - 1) * blocksWidth + x] = 1;
    well[(blocksHeight - 2) * blocksWidth] = 3;
    const after = slam({ ...newBlocks(3), well, level: 2, piece: { kind: "I", turn: 0, x: blocksWidth - 4, y: 0 } });
    expect(after.lines).toBe(1);
    expect(after.score).toBe((blocksHeight - 2) * 2 + 100 * 2);
    expect(after.well[(blocksHeight - 1) * blocksWidth]).toBe(3);
    expect(after.well.filter((c) => c !== 0).length).toBe(1);
  });

  test("a piece falls a row a tick, then lands; ten lines are the next level", () => {
    const g: Blocks = { ...newBlocks(5), piece: { kind: "O", turn: 0, x: 4, y: 0 } };
    expect(fall(g).piece.y).toBe(1);
    let h = g;
    for (let i = 0; i < blocksHeight; i++) h = fall(h);
    expect(h.well.filter((c) => c !== 0).length).toBe(4);
    expect(slam({ ...newBlocks(5), lines: 9 }).level).toBe(1);
    expect(fallMs(1)).toBe(800);
    expect(fallMs(20)).toBe(90);
  });

  test("a stack to the top ends the game, and nothing moves after", () => {
    const well = emptyWell();
    for (let y = 1; y < blocksHeight; y++) for (const x of [3, 4, 5, 6]) well[y * blocksWidth + x] = 2;
    const over = slam({ ...newBlocks(9), well, piece: { kind: "O", turn: 0, x: 0, y: 0 } });
    expect(over.over).toBe(true);
    expect(shift(over, 1)).toBe(over);
    expect(fall(over)).toBe(over);
  });
});

describe("小恐龙", () => {
  test("a jump rises, peaks and lands; only from the ground", () => {
    const up = run(jump(newDino(1)), 100);
    expect(up.lift).toBeGreaterThan(8);
    expect(jump(up).rise).toBe(up.rise);
    expect(runFor(up, 1200).lift).toBe(0);
  });

  test("a cactus ends a run on the ground; jumped in time, it passes under", () => {
    const cactus: Obstacle = { kind: "cactus", x: 22, y: dinoGround - 12, w: 6, h: 12 };
    const attention = withObstacles(newDino(2), [cactus], 999);
    expect(runFor(attention, 400).over).toBe(true);
    expect(runFor(jump(withObstacles(attention, [{ ...cactus, x: 26 }], 999)), 400).over).toBe(false);
  });

  test("a high bird is ducked under", () => {
    const bird: Obstacle = { kind: "bird", x: 22, y: dinoGround - 18, w: 12, h: 8 };
    const running = withObstacles(newDino(3), [bird], 999);
    expect(runFor(running, 400).over).toBe(true);
    expect(runFor(duck(running, true), 400).over).toBe(false);
  });

  test("obstacles keep coming, the ground speeds up, the score is the distance; a seed replays", () => {
    const long = runFor(newDino(4), 3000);
    expect(long.speed).toBeGreaterThan(newDino(4).speed);
    expect(dinoScore(long)).toBe(Math.floor(long.distance / 10));
    expect(runFor(newDino(4), 3000)).toEqual(long);
    const ended = { ...long, over: true };
    expect(run(ended, 100)).toBe(ended);
  });

  test("a seed replays the recorded run", () => {
    const d = runFor(newDino(4), 3000);
    expect(d.seed).toBe(-1263671336);
    expect(d.distance).toBeCloseTo(130.11089789109818, 9);
    expect(d.over).toBe(true);
    expect(d.obstacles.map((o) => o.kind)).toEqual(["cacti", "cactus"]);
    let e = jump(newDino(99));
    for (let t = 0; t < 20000; t += 16) e = run(e.lift === 0 ? jump(e) : e, 16);
    expect(e.seed).toBe(-1263671241);
    expect(e.distance).toBeCloseTo(244.85414448225558, 9);
    expect(e.time).toBe(3024);
  });

  test("every obstacle can be jumped at the starting speed, with a fair moment to jump", () => {
    const kinds: Obstacle[] = [
      { kind: "cactus", x: 0, y: dinoGround - 12, w: 6, h: 12 },
      { kind: "cacti", x: 0, y: dinoGround - 10, w: 12, h: 10 },
      { kind: "bird", x: 0, y: dinoGround - 12, w: 12, h: 8 },
    ];
    for (const o of kinds) {
      let clear = 0;
      for (let ahead = 10; ahead <= 80; ahead++) if (!runFor(jump(withObstacles(newDino(1), [{ ...o, x: 8 + ahead }], 9999)), 1500).over) clear++;
      expect(clear).toBeGreaterThanOrEqual(10);
    }
  });
});
