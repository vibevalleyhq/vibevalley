import "../polyfill";
import { expect, open, test } from "nsh/test";

import { fakeHost } from "../app/fakeHost";
import { responses, state } from "../fixtures/workbench";

test("the mounted handset launches all five games, routes pad keys and preserves a board", async () => {
  const host = fakeHost({ state, responses }, { view: "farm-phone", locale: "zh", calls: { open: true, narrow: false, ringing: null, missed: [], log: [] } });
  const phone = await open("../../App.tsx", { width: 388, height: 530, platform: "macos", host: host.options });
  await host.pump(phone);
  await phone.press("id:games");
  for (const id of ["blocks", "sokoban", "dino", "bugs", "merge"]) {
    await phone.press("id:" + id);
    await phone.waitUntil(() => phone.count("id:pad") === 1);
    if (id === "sokoban") {
      await phone.keyboard.press("right");
      expect(phone.texts()).toContain("1 步 · 1 推");
      await phone.keyboard.press("x");
      expect(phone.texts()).toContain("0 步 · 0 推");
    } else {
      await phone.keyboard.press("z");
      if (id === "blocks" || id === "bugs") {
        await phone.keyboard.press("x");
        expect(phone.texts().join("")).toContain("暂停");
      }
      if (id === "merge") {
        await phone.keyboard.press("enter");
        expect(phone.texts().join("")).toContain("重开");
        await phone.keyboard.press("x");
      }
    }
    await phone.press("id:phone-home");
    expect(phone.count("id:phone-games")).toBe(1);
    expect(phone.count("id:pad")).toBe(0);
  }
  await phone.press("id:blocks");
  expect(phone.texts().join("")).toContain("继续");
});
