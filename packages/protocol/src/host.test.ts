import { expect, test } from "vite-plus/test";
import { type ToNative, mobileHost } from "./host";

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
  expect(sent[0]).toEqual({ id: 1, call: "rtc.join", line: 1, grant: { appId: "a", channel: "c", uid: "7", token: "t" } });
  receive({ id: 1, ok: true });
  const line = await joining;
  receive({ line: 1, event: "rtc.joined" });
  receive({ line: 1, event: "rtc.stream", text: "{}" });
  receive({ line: 1, event: "rtc.levels", mine: 10, theirs: 40 });
  receive({ line: 1, event: "rtc.expiring" });
  const leaving = line.leave();
  receive({ id: 2, ok: true });
  await leaving;
  receive({ line: 1, event: "rtc.left" });
  expect(heard).toEqual(["joined", "{}", "10/40", "expiring"]);
  expect(host.tray).toBeNull();
});

test("a cancelled join's late cleanup does not detach the next call", async () => {
  const sent: ToNative[] = [];
  const { host, receive } = mobileHost((m) => sent.push(m));
  const heard: string[] = [];
  const events = {
    joined: () => undefined,
    left: () => undefined,
    stream: (text: string) => heard.push(text),
    levels: () => undefined,
    problem: () => undefined,
    expiring: () => undefined,
  };
  const cancelled = host.rtc!({ appId: "a", channel: "old", uid: "7", token: "t" }, events);
  const current = host.rtc!({ appId: "a", channel: "new", uid: "7", token: "t" }, events);
  receive({ id: 2, ok: true });
  await current;
  receive({ id: 1, ok: true });
  const old = await cancelled;
  const cleaning = old.leave();
  expect(sent[2]).toEqual({ id: 3, call: "rtc.leave", line: 1 });
  receive({ id: 3, ok: true });
  await cleaning;
  receive({ line: 1, event: "rtc.stream", text: "old call" });
  receive({ line: 2, event: "rtc.stream", text: "still here" });
  expect(heard).toEqual(["still here"]);
});

test("a superseded join's rejection does not detach the next call", async () => {
  const { host, receive } = mobileHost(() => undefined);
  const heard: string[] = [];
  const events = {
    joined: () => undefined,
    left: () => undefined,
    stream: (text: string) => heard.push(text),
    levels: () => undefined,
    problem: () => undefined,
    expiring: () => undefined,
  };
  const old = host.rtc!({ appId: "a", channel: "old", uid: "7", token: "t" }, events);
  const refused = expect(old).rejects.toThrow("ended");
  const current = host.rtc!({ appId: "a", channel: "new", uid: "7", token: "t" }, events);
  receive({ id: 2, ok: true });
  await current;
  receive({ id: 1, ok: false, error: "ended" });
  await refused;
  receive({ line: 2, event: "rtc.stream", text: "still here" });
  expect(heard).toEqual(["still here"]);
});
