import { expect, test } from "vite-plus/test";

import { actsForUser, type Actor, orchestrator, user, worker, system } from "./actor.ts";

test("only the user, or the orchestrator in a run the user's words are in, acts on the user's word", () => {
  const cases: [Actor, boolean][] = [
    [user, true],
    [orchestrator(true), true],
    [orchestrator(false), false],
    [worker("w1"), false],
    [system, false],
  ];
  expect(cases.map(([a]) => actsForUser(a))).toEqual(cases.map(([, yes]) => yes));
});
