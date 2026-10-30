import { expect, test } from "vite-plus/test";

import type { BridgeMessage } from "@vibevalley/bridge";
import { linkPair } from "@vibevalley/bridge/testing";

import { mobileHost, type RtcEvents } from "./host";

const grant = (channel: string) => ({ appId: "a", channel, uid: "7", token: "t" });

function phone() {
  const [page, shell] = linkPair();
  const asked: BridgeMessage[] = [];
  shell.receive((m) => asked.push(m as BridgeMessage));
  return {
    host: mobileHost(page),
    asked,
    answer: (id: number, error?: string) => shell.send(error === undefined ? { id, ok: true } : { id, ok: false, error }),
    push: (name: string, payload: object) => shell.send({ push: name, payload }),
  };
}

const streamTo = (heard: string[]): RtcEvents => ({
  joined: () => heard.push("joined"),
  left: () => heard.push("left"),
  stream: (t) => heard.push(t),
  levels: (a, b) => heard.push(`${a}/${b}`),
  problem: (t) => heard.push("!" + t),
  expiring: () => heard.push("expiring"),
});

test("a call goes out by id, and its answer settles it", async () => {
  const p = phone();
  const told = p.host.notify!({ title: "做完了", body: "收菜" });
  expect(p.asked).toEqual([{ id: 1, call: "notify", input: { title: "做完了", body: "收菜" } }]);
  p.answer(1);
  await told;
  const refused = p.host.notify!({ title: "a", body: "b" });
  p.answer(2, "没有通知权限");
  await expect(refused).rejects.toThrow("没有通知权限");
});

test("a call's events reach its listener until it leaves", async () => {
  const p = phone();
  const heard: string[] = [];
  const joining = p.host.rtc!(grant("c"), streamTo(heard));
  expect(p.asked[0]).toEqual({ id: 1, call: "rtcJoin", input: { line: 1, grant: grant("c") } });
  p.answer(1);
  const line = await joining;
  p.push("rtcJoined", { line: 1 });
  p.push("rtcStream", { line: 1, text: "{}" });
  p.push("rtcLevels", { line: 1, mine: 10, theirs: 40 });
  p.push("rtcExpiring", { line: 1 });
  const leaving = line.leave();
  p.answer(2);
  await leaving;
  p.push("rtcLeft", { line: 1 });
  expect(heard).toEqual(["joined", "{}", "10/40", "expiring"]);
  expect(p.host.tray).toBeUndefined();
});

test("a cancelled join's late cleanup does not detach the next call", async () => {
  const p = phone();
  const heard: string[] = [];
  const cancelled = p.host.rtc!(grant("old"), streamTo(heard));
  const current = p.host.rtc!(grant("new"), streamTo(heard));
  p.answer(2);
  await current;
  p.answer(1);
  const old = await cancelled;
  const cleaning = old.leave();
  expect(p.asked[2]).toEqual({ id: 3, call: "rtcLeave", input: { line: 1 } });
  p.answer(3);
  await cleaning;
  p.push("rtcStream", { line: 1, text: "old call" });
  p.push("rtcStream", { line: 2, text: "still here" });
  expect(heard).toEqual(["still here"]);
});

test("a superseded join's rejection does not detach the next call", async () => {
  const p = phone();
  const heard: string[] = [];
  const old = p.host.rtc!(grant("old"), streamTo(heard));
  const refused = expect(old).rejects.toThrow("ended");
  const current = p.host.rtc!(grant("new"), streamTo(heard));
  p.answer(2);
  await current;
  p.answer(1, "ended");
  await refused;
  p.push("rtcStream", { line: 2, text: "still here" });
  expect(heard).toEqual(["still here"]);
});
