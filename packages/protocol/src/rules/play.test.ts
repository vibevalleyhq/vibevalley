import { expect, test } from "vite-plus/test";
import type { Session } from "../shapes";
import { emptyCoreState, reduce } from "./core";
import { playOf, withStations } from "./play";

const session = (id: string, project?: string): Session => ({
  id,
  name: id,
  agent: "a",
  runtime: "nobody",
  brief: "",
  ...(project !== undefined ? { project } : {}),
  hiredAt: 0,
  runs: 0,
  phase: { _tag: "working", since: 0 } as Session["phase"],
});

const hire = (state = emptyCoreState(), h: Session) => reduce(state, { type: "hired", at: 0, session: h })[0];
const bed = (state: ReturnType<typeof emptyCoreState>, id: string) => playOf(state.sessions.find((h) => h.id === id)!).station;

test("each project's farm has its own beds: the first of each is on bed 0", () => {
  let s = hire(undefined, session("a1", "alpha"));
  s = hire(s, session("b1", "beta"));
  s = hire(s, session("a2", "alpha"));
  s = hire(s, session("x1"));
  expect([bed(s, "a1"), bed(s, "b1"), bed(s, "a2"), bed(s, "x1")]).toEqual([0, 0, 1, 0]);
});

test("a bed taken on another project's farm is free on this one, and taken on its own is not", () => {
  let s = hire(undefined, session("a1", "alpha"));
  s = hire(s, session("b1", "beta"));
  const [moved, changed] = reduce(s, { type: "station", at: 0, id: "b1", station: 3 });
  expect(changed).toBe(true);
  // b1 holds bed 3 on beta's farm: b2 cannot take it, and stays on beta's first free bed.
  const [again, took] = reduce(hire(moved, session("b2", "beta")), { type: "station", at: 0, id: "b2", station: 3 });
  expect(took).toBe(false);
  expect(bed(again, "b2")).toBe(0);
});

test("a saved bed another session of its farm holds moves to a free one", () => {
  const on = (h: Session, station: number): Session => ({ ...h, play: { ...playOf(h), station } });
  const s = withStations({ ...emptyCoreState(), sessions: [on(session("a1", "alpha"), 0), on(session("a2", "alpha"), 0), on(session("b1", "beta"), 0)] });
  expect(s.sessions.map((h) => playOf(h).station)).toEqual([0, 1, 0]);
});
