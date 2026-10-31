import { afterEach, expect, test, vi } from "vite-plus/test";

import { farm, farmProject, farmState, lastFarmProject, overlayOf, resetFarm } from "./store";
import { aimTool, farmKey } from "./tools";
import { beds } from "./world/plots";
afterEach(() => {
  vi.useRealTimers();
  resetFarm();
});

test("overlays stack in their fixed order, one of each kind, and close from the top", () => {
  farm.panel("shop");
  farm.select("s1");
  farm.panel("log");
  expect(farmState().overlays.map((o) => o.kind)).toEqual(["inspect", "panel"]);
  expect(overlayOf(farmState(), "panel")?.panel).toBe("log");
  expect(farm.closeTop()).toBe(true);
  expect(farm.closeTop()).toBe(true);
  expect(farm.closeTop()).toBe(false);
});

test("a bed's effect plays for a while, then goes", () => {
  vi.useFakeTimers();
  farm.bedFx(2, "water");
  expect(farmState().bedFx).toMatchObject([{ bed: 2, kind: "water" }]);
  vi.advanceTimersByTime(2300);
  expect(farmState().bedFx).toEqual([]);
});

test("Escape opens the menu with the hand and puts a tool down; an open layer keeps its Escape; typing keeps the digits", () => {
  const key = (k: string) => ({ key: k, down: true, meta: false, control: false, alt: false });
  expect(farmKey(key("Escape"), false, false, "hand")).toEqual({ kind: "openMenu" });
  expect(farmKey(key("Escape"), false, false, "water")).toEqual({ kind: "closeTool" });
  expect(farmKey(key("Escape"), false, true, "hand")).toBeUndefined();
  expect(farmKey(key("2"), false, false, "hand")).toEqual({ kind: "pick", tool: "water" });
  expect(farmKey(key("2"), true, false, "hand")).toBeUndefined();
});

test("a locked bed says when it clears; the hand sows an empty bed", () => {
  expect(aimTool("hand", beds[7]!, undefined, { crop: "locked" }, 3)).toEqual({ ok: false, text: "Lv.8 开垦这块地" });
  expect(aimTool("hand", beds[0]!, undefined, { crop: "empty" }, 3)).toEqual({ ok: true, text: "播种" });
});

test("the title, once closed, stays closed on this machine; the farm entered is the one /farm opens next", () => {
  farm.showTitle();
  farm.closeTitle();
  resetFarm();
  expect(farmState().titleOpen).toBe(false);
  farm.setProject("clock-in");
  expect(farmProject()).toBe("clock-in");
  expect(lastFarmProject()).toBe("clock-in");
  farm.setProject("");
  expect(lastFarmProject()).toBe("");
});
