import { expect, test } from "vite-plus/test";
import type { InboxItem } from "@vibevalley/protocol";
import { missedOf, PhoneCalls, ringEvery, ringFor } from "./calls";

const call = (id: string): InboxItem => ({
  id,
  kind: "merge",
  from: { kind: "session", id: "s1", name: "阿狐", agent: "fox" },
  text: "做完了",
  at: 0,
  target: { kind: "session", id: "s1" },
});

/** A phone on a hand-turned clock. */
function phone(open = false) {
  let now = 0;
  const timers: { at: number; every?: number; f: () => void }[] = [];
  const rings: number[] = [];
  const host = {
    open,
    isOpen: () => host.open,
    setOpen: (o: boolean) => void (host.open = o),
    play: (s: string) => void (s === "ring" && rings.push(now)),
    every: (ms: number, f: () => void) => {
      const t = { at: now + ms, every: ms, f };
      timers.push(t);
      return () => void timers.splice(timers.indexOf(t), 1);
    },
    after: (ms: number, f: () => void) => {
      const t = { at: now + ms, f };
      timers.push(t);
      return () => void timers.splice(timers.indexOf(t), 1);
    },
    now: () => now,
  };
  const calls = new PhoneCalls(host);
  const wait = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      if (next.every) next.at += next.every;
      else timers.splice(timers.indexOf(next), 1);
      next.f();
    }
    now = until;
  };
  return { calls, host, rings, wait };
}

test("the first look rings nothing; a new call rings, opens the phone, and gives up after a while", () => {
  const { calls, host, rings, wait } = phone();
  calls.resume();
  calls.calls([call("a")]);
  expect(calls.get().ringing).toBeNull();
  expect(missedOf(calls.get()).map((c) => c.id)).toEqual(["a"]);
  calls.calls([call("a"), call("b")]);
  expect(calls.get().ringing?.id).toBe("b");
  expect(host.open).toBe(true);
  wait(ringFor);
  expect(rings).toEqual([0, ...Array.from({ length: ringFor / ringEvery }, (_, i) => (i + 1) * ringEvery)]);
  expect(calls.get().ringing).toBeNull();
  expect(host.open).toBe(false);
  expect(missedOf(calls.get()).map((c) => c.id)).toEqual(["a", "b"]);
});

test("a call answered elsewhere stops ringing; one already open stays open", () => {
  const { calls, host } = phone(true);
  calls.resume();
  calls.calls([]);
  calls.calls([call("a")]);
  expect(calls.get().ringing?.id).toBe("a");
  calls.calls([]);
  expect(calls.get().ringing).toBeNull();
  expect(host.open).toBe(true);
});

test("answering logs the call, takes it off the missed and puts the phone away; hanging up only logs it", () => {
  const { calls, host } = phone();
  calls.resume();
  calls.calls([]);
  calls.calls([call("a"), call("b")]);
  calls.settle(call("a"), true);
  expect(calls.get().ringing).toBeNull();
  expect(host.open).toBe(false);
  calls.settle(call("b"), false);
  expect(missedOf(calls.get())).toEqual([]);
  expect(calls.get().log.map((e) => [e.call.id, e.answered])).toEqual([
    ["b", false],
    ["a", true],
  ]);
});

test("nothing rings while the farm is away, and coming back primes again", () => {
  const { calls } = phone();
  calls.resume();
  calls.calls([]);
  calls.pause();
  calls.calls([call("a")]);
  expect(calls.get().ringing).toBeNull();
  calls.resume();
  calls.calls([call("a")]);
  expect(calls.get().ringing).toBeNull();
  calls.calls([call("a"), call("b")]);
  expect(calls.get().ringing?.id).toBe("b");
});
