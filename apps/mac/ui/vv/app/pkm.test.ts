// The vendored pkm logic (packages/pkm, features/pkm/*.ts) runs under nsh:
// the groundwork of the notes page.
import "../polyfill";
import { expect, test } from "nsh/test";

import { dayKey } from "../web/features/pkm/days";
import { dropAt } from "../web/features/pkm/selection";
import { pkmHref } from "../web/features/pkm/vault";

test("days, links and selection from VibeValley's pkm", () => {
  expect(dayKey(new Date(2026, 10, 13, 9).getTime())).toBe("2026-11-13");
  expect(pkmHref("journal/2026-11-13", "b1")).toBe("/pkm/journal%2F2026-11-13?b=b1");
  expect(typeof dropAt).toBe("function");
});
