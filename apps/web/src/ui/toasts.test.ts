import { afterEach, expect, test, vi } from "vite-plus/test";

import { toast, toasts } from "./toasts";

afterEach(() => vi.useRealTimers());

test("a toast is on the page's list for four seconds, in its tone, and every reader hears it come and go", () => {
  vi.useFakeTimers();
  const heard = vi.fn();
  const off = toasts.subscribe(heard);
  toast("已保存");
  toast("没发出去", "bad");
  expect(toasts.get().map((t) => [t.text, t.tone])).toEqual([
    ["已保存", "info"],
    ["没发出去", "bad"],
  ]);
  vi.advanceTimersByTime(4000);
  expect(toasts.get()).toEqual([]);
  expect(heard).toHaveBeenCalledTimes(4);
  off();
});
