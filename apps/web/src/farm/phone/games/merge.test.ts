// The same seeds must replay the same games: the recorded ones are kept.
import { describe, expect, test } from "vite-plus/test";
import {
  canSlide,
  type Merge,
  type MergeDirection,
  mergeGoal,
  mergeSize,
  mergeStageName,
  mergeStages,
  mergeTop,
  newMerge,
  slideMerge,
  undoMerge,
} from "./merge";

const on = (board: number[], seed = 1): Merge => ({ ...newMerge(seed), board });
const slid = (g: Merge) => g.board.map((v, i) => (i === g.sown ? 0 : v));
const dirs: Record<string, MergeDirection> = { l: "left", u: "up", r: "right", d: "down" };
const play = (seed: number, path: string) => [...path].reduce((g, c) => slideMerge(g, dirs[c]!), newMerge(seed));

describe("merge", () => {
  test("a seed replays the recorded games", () => {
    const cases: [number, string, string, number, string, number, number, number, number[], number][] = [
      [42, "lurdllurrdduuldr", "0000001001000000", -631835628, "0,0,0,0,0,1,2,1,0,1,2,1,0,0,2,4", 60, 16, -1391553692, [15], 5],
      [7, "ddddllllrrrruuuu", "1100000000000000", -631835663, "2,1,2,3,0,0,1,1,0,0,2,1,0,0,0,0", 28, 12, -127882387, [], 11],
      [123456789, "lulululurdrdrdrdldlduuu", "0000100000000001", -508378881, "1,3,2,0,2,4,0,0,3,1,0,0,0,0,0,0", 88, 20, 1763199011, [], 9],
    ];
    for (const [seed, path, start, startSeed, board, score, moves, seedAfter, grown, sown] of cases) {
      const n = newMerge(seed);
      expect(n.board.join("")).toBe(start);
      expect(n.seed).toBe(startSeed);
      const g = play(seed, path);
      expect(g.board.join(",")).toBe(board);
      expect(g.score).toBe(score);
      expect(g.moves).toBe(moves);
      expect(g.seed).toBe(seedAfter);
      expect([...g.grown]).toEqual(grown);
      expect(g.sown).toBe(sown);
      expect(g.over).toBe(false);
    }
    // A long game to the end, slides picked by a little LCG: Math.imul(r, 1103515245) + 12345, (r >>> 16) & 3.
    let g = newMerge(2024);
    let r = 99;
    let k = 0;
    const order: MergeDirection[] = ["left", "up", "right", "down"];
    while (!g.over && k < 5000) {
      r = (Math.imul(r, 1103515245) + 12345) | 0;
      g = slideMerge(g, order[(r >>> 16) & 3]!);
      k++;
    }
    expect(g.board.join(",")).toBe("1,3,5,1,3,4,8,3,2,5,6,5,1,4,3,1");
    expect(g.score).toBe(2660);
    expect(g.moves).toBe(244);
    expect(g.seed).toBe(-406374058);
    expect(g.over).toBe(true);
    expect(k).toBe(291);
  });

  test("a new field has two seeds, and a seed lays them out the same again", () => {
    const g = newMerge(42);
    expect(g.board.length).toBe(mergeSize * mergeSize);
    expect(g.board.filter((c) => c !== 0)).toEqual([1, 1]);
    expect(newMerge(42)).toEqual(g);
    expect(play(7, "lurdllu")).toEqual(play(7, "lurdllu"));
  });

  test("crops slide to the edge; two of a stage grow into the next, once a slide, nearest the edge first", () => {
    const after = slideMerge(on([1, 1, 1, 1, 2, 0, 2, 3, 1, 1, 2, 0, 0, 0, 0, 4]), "left");
    expect(slid(after)).toEqual([2, 2, 0, 0, 3, 3, 0, 0, 2, 2, 0, 0, 4, 0, 0, 0]);
    expect(after.score).toBe(4 + 4 + 8 + 4);
    expect([...after.grown]).toEqual([0, 1, 4, 8]);
    expect(after.board[after.sown]).toBe(1);
    expect(after.moves).toBe(1);
    expect(slid(slideMerge(on([0, 1, 1, 1, ...Array(12).fill(0)]), "right")).slice(0, 4)).toEqual([0, 0, 1, 2]);
    expect(slid(slideMerge(on([2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), "down")).filter((c) => c !== 0)).toEqual([3, 2]);
  });

  test("a slide that moves nothing is no move: no seed, the same game back", () => {
    const g = on([1, 2, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(slideMerge(g, "left")).toBe(g);
    expect(slideMerge(g, "up")).toBe(g);
    expect(slideMerge(g, "right")).not.toBe(g);
  });

  test("a full field with no pair side by side ends the run, and nothing slides after", () => {
    const full = [2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2, 1, 3, 4, 3, 0];
    expect(canSlide(full)).toBe(true);
    const g = slideMerge(on(full), "right");
    expect(g.board.slice(12)).toEqual([1, 3, 4, 3]);
    expect(g.over).toBe(true);
    expect(canSlide(g.board)).toBe(false);
    for (const d of ["left", "right", "up", "down"] as const) expect(slideMerge(g, d)).toBe(g);
  });

  test("one slide comes back, seed and all; not two", () => {
    const g = play(9, "lu");
    const next = slideMerge(g, "right");
    const back = undoMerge(next);
    expect(back).toEqual({ ...g, previous: undefined });
    expect(slideMerge(back, "right").board).toEqual(next.board);
    expect(undoMerge(back)).toBe(back);
  });

  test("丰收 is the eleventh stage, 2048; past it the stages count on", () => {
    expect(2 ** mergeGoal).toBe(2048);
    expect(mergeStages.length).toBe(mergeGoal);
    expect(mergeStageName(1)).toBe("种子");
    expect(mergeStageName(mergeGoal)).toBe("丰收");
    expect(mergeStageName(mergeGoal + 1)).toBe("丰收2");
    const g = slideMerge(on([10, 10, ...Array(14).fill(0)]), "left");
    expect(mergeTop(g)).toBe(mergeGoal);
    expect(g.score).toBe(2048);
  });
});
