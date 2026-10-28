import { t } from "@vibevalley/i18n";
// 合成: 2048 with crops. Slide the field; two of a stage grow into the next; a seed is sown
// on an empty cell after every slide that moves something. One slide back can be taken.

import { nextRandom } from "./random";

export const mergeSize = 4;

/** A stage is worth 2^stage, as the tiles of 2048 are. Past the last, the last stage counts on. */
export const mergeStages = ([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const).map((i) => t(`web.farm.phone.merge.stage.${i}`));

export const mergeGoal = 11;

export type MergeDirection = "left" | "right" | "up" | "down";

export interface Merge {
  /** 0 is empty, else the crop's stage. */
  readonly board: readonly number[];
  readonly score: number;
  readonly moves: number;
  readonly seed: number;
  /** The cells that grew in the last slide. */
  readonly grown: readonly number[];
  /** Where the last seed went; -1 before any slide. */
  readonly sown: number;
  readonly over: boolean;
  /** One step back, no further. */
  readonly previous: Merge | null;
}

export const mergeStageName = (stage: number) => (stage <= mergeGoal ? mergeStages[stage - 1]! : t("web.farm.phone.merge.past", { n: stage - mergeGoal + 1 }));

export const mergeTop = (g: Merge) => Math.max(0, ...g.board);

function sow(board: readonly number[], seed: number): [number[], number, number] {
  const empty = board.flatMap((v, i) => (v === 0 ? [i] : []));
  if (empty.length === 0) return [[...board], -1, seed];
  const [r, s] = nextRandom(seed);
  const at = empty[Math.floor(r * empty.length)]!;
  const next = [...board];
  next[at] = 1;
  return [next, at, s];
}

function lines(direction: MergeDirection): number[][] {
  const n = mergeSize;
  return Array.from({ length: n }, (_, a) =>
    Array.from({ length: n }, (_, b) => {
      switch (direction) {
        case "left":
          return a * n + b;
        case "right":
          return a * n + (n - 1 - b);
        case "up":
          return b * n + a;
        case "down":
          return (n - 1 - b) * n + a;
      }
    }),
  );
}

export function canSlide(board: readonly number[]) {
  const n = mergeSize;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0) return true;
    if (i % n < n - 1 && board[i] === board[i + 1]) return true;
    if (i + n < board.length && board[i] === board[i + n]) return true;
  }
  return false;
}

export function newMerge(seed: number): Merge {
  const [one, , s1] = sow(Array<number>(mergeSize * mergeSize).fill(0), seed);
  const [board, , s2] = sow(one, s1);
  return { board, score: 0, moves: 0, seed: s2, grown: [], sown: -1, over: false, previous: null };
}

export function slideMerge(g: Merge, direction: MergeDirection): Merge {
  if (g.over) return g;
  const board = [...g.board];
  const grown: number[] = [];
  let gained = 0;
  for (const line of lines(direction)) {
    const crops = line.map((i) => g.board[i]!).filter((v) => v !== 0);
    const out: number[] = [];
    for (let k = 0; k < crops.length; k++) {
      if (k + 1 < crops.length && crops[k] === crops[k + 1]) {
        const stage = crops[k]! + 1;
        grown.push(line[out.length]!);
        out.push(stage);
        gained += 2 ** stage;
        k++;
      } else out.push(crops[k]!);
    }
    line.forEach((cell, k) => (board[cell] = k < out.length ? out[k]! : 0));
  }
  if (board.every((v, i) => v === g.board[i])) return g;
  const [sown, at, seed] = sow(board, g.seed);
  return { board: sown, score: g.score + gained, moves: g.moves + 1, seed, grown, sown: at, over: !canSlide(sown), previous: { ...g, previous: null } };
}

/** The same slide again brings the same seed. */
export const undoMerge = (g: Merge) => g.previous ?? g;
