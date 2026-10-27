import { expect, test } from "vite-plus/test";
import { isMuted, playSound, SOUND_GROUPS, SOUND_LABEL, SOUNDS } from "./sound";

test("every sound has a label and a group", () => {
  const names = Object.keys(SOUNDS).sort();
  expect(Object.keys(SOUND_LABEL).sort()).toEqual(names);
  expect(SOUND_GROUPS.flatMap((g) => g.names).sort()).toEqual(names as (typeof SOUND_GROUPS)[number]["names"][number][]);
});

test("without audio or storage it stays quiet", () => {
  expect(isMuted()).toBe(false);
  expect(() => playSound("coin")).not.toThrow();
});
