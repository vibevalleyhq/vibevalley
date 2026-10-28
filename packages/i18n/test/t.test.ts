import { expect, test } from "vite-plus/test";
import { format, list, placeholders, setLocale, t } from "../src";

test("a message is said in the language in use, its placeholders filled", () => {
  setLocale("zh");
  expect(t("web.setting.keys.saved")).toBe("存好了，马上就用上。");
  expect(t("web.setting.source.configure", { label: "EverOS" })).toBe("配置 EverOS");
  setLocale("en");
  expect(t("web.setting.source.configure", { label: "EverOS" })).toBe("Set up EverOS");
  expect(list(["a", "b"])).toBe("a, b");
  setLocale("zh");
  expect(list(["甲", "乙"])).toBe("甲、乙");
});

test("placeholders are {name}; one not given stays as written", () => {
  expect(format("{a} 和 {b}", { a: 1 })).toBe("1 和 {b}");
  expect(placeholders("{a} {b} {a}")).toEqual(["a", "b"]);
});

test("a key or params that do not fit do not compile", () => {
  // @ts-expect-error no such key
  t("web.setting.nope");
  // @ts-expect-error a template needs its params
  t("web.setting.source.configure");
  // @ts-expect-error a plain message takes none
  t("web.setting.keys.saved", { x: 1 });
});
