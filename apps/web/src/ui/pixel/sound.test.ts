import { expect, test } from "vite-plus/test";

import { isMuted, playSound, SOUND_GROUPS, SOUND_LABEL, SOUNDS } from "./sound";

test("every sound has a label and a group", () => {
  const names = Object.keys(SOUNDS).toSorted();
  expect(Object.keys(SOUND_LABEL).toSorted()).toEqual(names);
  expect(SOUND_GROUPS.flatMap((g) => g.names).toSorted()).toEqual(names as (typeof SOUND_GROUPS)[number]["names"][number][]);
});

test("without audio or storage it stays quiet", () => {
  expect(isMuted()).toBe(false);
  expect(() => playSound("coin")).not.toThrow();
});
