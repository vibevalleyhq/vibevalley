import { expect, test } from "vite-plus/test";

import * as S from "@vibevalley/protocol/schema";

test("a fact naming an action the farm does not know is refused", () => {
  expect(() =>
    S.Fact.parse({
      type: "sessionPhaseChanged",
      at: 1,
      id: "w1",
      phase: { _tag: "working", since: 1, doing: { action: "dance", label: "" } },
    }),
  ).toThrow(/run_command/u);
});
