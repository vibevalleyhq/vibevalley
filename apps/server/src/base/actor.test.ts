import { expect, test } from "vite-plus/test";
import { actsForOwner, type Actor, orchestrator, owner, session, system } from "./actor.ts";

test("only the owner, or the orchestrator in a run the owner's words are in, acts on the owner's word", () => {
  const cases: [Actor, boolean][] = [
    [owner, true],
    [orchestrator(true), true],
    [orchestrator(false), false],
    [session("w1"), false],
    [system, false],
  ];
  expect(cases.map(([a]) => actsForOwner(a))).toEqual(cases.map(([, yes]) => yes));
});
