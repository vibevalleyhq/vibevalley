import { expect, test } from "vite-plus/test";
import { type ToNative, mobileHost } from "./mobile";

test("a call goes out by id, and its answer settles it", async () => {
  const sent: ToNative[] = [];
  const { host, receive } = mobileHost((m) => sent.push(m));
  const told = host.notify!({ title: "做完了", body: "收菜" });
  expect(sent).toEqual([{ id: 1, call: "notify", notice: { title: "做完了", body: "收菜" } }]);
  receive({ id: 1, ok: true });
  await told;
  const refused = host.notify!({ title: "a", body: "b" });
  receive({ id: 2, ok: false, error: "没有通知权限" });
  await expect(refused).rejects.toThrow("没有通知权限");
});

test("a call's events reach its listener until it leaves", async () => {
  const sent: ToNative[] = [];
  const { host, receive } = mobileHost((m) => sent.push(m));
  const heard: string[] = [];
  const joining = host.rtc!(
    { appId: "a", channel: "c", uid: "7", token: "t" },
    {
      joined: () => heard.push("joined"),
      left: () => heard.push("left"),
      stream: (t) => heard.push(t),
      levels: (a, b) => heard.push(`${a}/${b}`),
      problem: (t) => heard.push("!" + t),
      expiring: () => heard.push("expiring"),
    },
  );
  expect(sent[0]).toEqual({ id: 1, call: "rtc.join", grant: { appId: "a", channel: "c", uid: "7", token: "t" } });
  receive({ id: 1, ok: true });
  const line = await joining;
  receive({ event: "rtc.joined" });
  receive({ event: "rtc.stream", text: "{}" });
  receive({ event: "rtc.levels", mine: 10, theirs: 40 });
  receive({ event: "rtc.expiring" });
  const leaving = line.leave();
  receive({ id: 2, ok: true });
  await leaving;
  receive({ event: "rtc.left" });
  expect(heard).toEqual(["joined", "{}", "10/40", "expiring"]);
  expect(host.tray).toBeNull();
});
