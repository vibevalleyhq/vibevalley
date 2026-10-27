import { afterEach, expect, test, vi } from "vite-plus/test";
import { splitChips } from "./chips";
import { pickItems } from "./pick";
import { plainText, withMentions } from "./markdown";
import { ToastStore } from "./toasts";

// The toasts' timeouts run on fake timers, moved through rather than waited out.
afterEach(() => vi.useRealTimers());
const wait = (ms: number) => vi.advanceTimersByTime(ms);

test("toasts come newest first and close after their timeout", () => {
  vi.useFakeTimers();
  const store = new ToastStore();
  let heard = 0;
  store.subscribe(() => heard++);
  const a = store.add({ title: "一", timeout: 20 });
  const b = store.add({ title: "二", type: "warn", timeout: 0 });
  expect(store.toasts.map((t) => t.id)).toEqual([b, a]);
  expect(store.toasts[1]?.type).toBe("info");
  wait(40);
  expect(store.toasts.map((t) => t.id)).toEqual([b]);
  store.close(b);
  expect(store.toasts).toEqual([]);
  expect(heard).toBe(4);
});

test("a paused toast keeps what was left of its timeout", () => {
  vi.useFakeTimers();
  const store = new ToastStore();
  store.add({ title: "一", timeout: 30 });
  store.pause();
  wait(50);
  expect(store.toasts).toHaveLength(1);
  store.resume();
  wait(50);
  expect(store.toasts).toHaveLength(0);
});

test("mentions become links outside code", () => {
  expect(withMentions("@w3 看看 `@w4` 和 @管家")).toBe("[@w3](#mention) 看看 `@w4` 和 [@管家](#mention)");
  expect(withMentions("a@w3 @someone")).toBe("a@w3 @someone");
});

test("plainText drops the marks", () => {
  expect(plainText("# 标题\n**粗** 和 [链接](http://x) `code`")).toBe("标题 粗 和 链接 code");
});

test("chips split at either comma, without repeats", () => {
  expect(splitChips(" a, b，a ,, c", ["c"])).toEqual(["a", "b"]);
});

test("a pick lists its placeholder only when clearable", () => {
  const options = [
    { value: "", label: "所有" },
    { value: "p", label: "岛" },
  ];
  expect(pickItems(options, "所有项目", false).map((o) => o.value)).toEqual(["p"]);
  expect(pickItems(options, "所有项目", true).map((o) => o.label)).toEqual(["所有项目", "岛"]);
});
