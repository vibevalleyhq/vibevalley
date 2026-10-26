import { describe, expect, it } from "@effect/vitest";
import type { Recurrence, RecurrenceRequest, RecurrenceWhen } from "@vibevalley/protocol";
import { RecurrenceWhenWeekly } from "@vibevalley/protocol/schema";
import { nextText } from "./when.ts";
import { Effect, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { test } from "vite-plus/test";
import { type Config } from "../base/config.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { checkCases, goldenCases } from "../testing/golden.ts";
import { testConfig } from "../testing/layers.ts";
import { aTurn } from "../testing/until.ts";
import { world } from "../testing/world.ts";
import { afterRun, dueRecurrences, isMissed, needsOK } from "./rules.ts";
import { type Due, Recurrences } from "./recurrence.ts";
import * as q from "../../db/generated/recurrence.sql.ts";

test("the recorded cases", () => {
  const cases = goldenCases("recurrence");
  expect(new Set(cases.map((c) => c.fn))).toEqual(new Set(["due"]));
  const failed = checkCases(cases, (c) => {
    const i = c.in as { s: Recurrence; now: number };
    return { due: dueRecurrences([i.s], i.now).length, missed: isMissed(i.s, i.now) };
  });
  expect(failed).toEqual([]);
});

const at = (iso: string) => Date.parse(iso + "+08:00");

test("due once, missed, and run", () => {
  const s = {
    id: "x1",
    name: "测试",
    text: "跑一遍测试",
    channel: "c1",
    when: { kind: "daily", time: "09:00" },
    tz: "Asia/Shanghai",
    enabled: true,
    created: at("2026-10-01T08:00:00"),
    lastRun: at("2026-10-09T09:00:00"),
    by: "owner",
  } as Recurrence;
  const now = at("2026-10-12T11:00:00");
  expect(dueRecurrences([s], now)).toEqual([s]);
  expect(isMissed(s, now)).toBe(true);
  expect(dueRecurrences([afterRun(s, now)], now)).toEqual([]);
  expect(isMissed(s, at("2026-10-10T09:00:20"))).toBe(false);
  expect(afterRun({ ...s, when: { kind: "once", at: at("2026-10-12T12:00:00") } }, now).enabled).toBe(false);
});

test("what waits for the owner's yes", () => {
  const once: RecurrenceWhen = { kind: "once", at: at("2026-10-12T12:00:00") };
  const daily: RecurrenceWhen = { kind: "daily", time: "09:00" };
  const req = (when: RecurrenceWhen, agent?: string) => ({ name: "", text: "", when, ...(agent !== undefined ? { agent } : {}) }) as RecurrenceRequest;
  expect(needsOK(req(daily, "lab"), "owner", false)).toBe(false);
  expect(needsOK(req(daily, "lab"), "orchestrator", true)).toBe(false);
  expect(needsOK(req(once), "orchestrator", false)).toBe(false);
  expect(needsOK(req(daily), "orchestrator", false)).toBe(true);
  expect(needsOK(req(once, "lab"), "orchestrator", false)).toBe(true);
  expect(needsOK(req(once, " "), "orchestrator", false)).toBe(false);
});

/** The farm with recurrences on a clock turned by hand. */
const farm = (config: Config, clock: { now: number }) => world({ config, clock: () => clock.now });

const collect = Effect.gen(function* () {
  const got: Due[] = [];
  yield* Effect.forkScoped(Stream.runForEach(yield* (yield* Recurrences).due, (d) => Effect.sync(() => got.push(d))));
  return got;
});

/** What a tick makes due is published before the tick returns: a turn lets the collecting fiber take it. */
const drained = aTurn;

const req = (name: string, text: string, when: RecurrenceWhen, more: Partial<RecurrenceRequest> = {}): RecurrenceRequest => ({ name, text, when, ...more });

describe("recurrences", () => {
  it.live("come due, say so, are kept, and come back on", () => {
    const config = { ...testConfig(), db: "" };
    const clock = { now: Date.UTC(2026, 9, 13, 8) };
    let everyId = "";
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const s = yield* Recurrences;
        const core = yield* Core;
        const chat = yield* Channels;
        const due = yield* collect;
        const general = chat.general();
        const made = yield* s.add(req(" 看进度 ", "看看帮工们的进度", { kind: "once", at: clock.now + 150 }), "owner", true);
        expect([made.channel, made.name, made.enabled, made.tz !== ""]).toEqual([general, "看进度", true, true]);
        expect(core.state().recurrences?.map((x) => x.id)).toEqual([made.id]);
        yield* s.tick;
        yield* drained;
        expect(due).toEqual([]);
        clock.now += 200;
        yield* s.tick;
        yield* drained;
        expect(due.map((d) => [d.recurrence.id, d.missed, d.recurrence.enabled])).toEqual([[made.id, false, false]]);
        const last = (yield* chat.history(general)).at(-1)!;
        expect([last.kind, last.text]).toEqual(["notice", "⏰ 定时「看进度」到点了：看看帮工们的进度"]);
        expect(s.list()[0]!.enabled).toBe(false);
        yield* s.tick;
        expect(yield* Effect.flip(s.add(req("x", "y", { kind: "every", minutes: 5 }, { agent: "lab" }), "owner", true))).toMatchObject({
          reason: expect.stringContaining("默认项目"),
        });
        expect(yield* Effect.flip(s.add(req("x", "y", { kind: "every", minutes: 5 }, { agent: "nobody" }), "owner", true))).toMatchObject({
          reason: expect.stringContaining("没有叫 nobody"),
        });
        expect(yield* Effect.flip(s.add(req("x", "y", { kind: "every", minutes: 5 }, { channel: "elsewhere" }), "owner", true))).toMatchObject({
          reason: expect.stringContaining("elsewhere"),
        });
        const every = yield* s.add(req("巡检", "跑一遍检查", { kind: "every", minutes: 5 }, { agent: "lab", project: "demo" }), "owner", true);
        expect([every.agent, every.project]).toEqual(["lab", "demo"]);
        everyId = every.id;
        yield* s.setEnabled(every.id, false);
      }).pipe(Effect.scoped, Effect.provide(farm(config, clock)));

      yield* Effect.gen(function* () {
        const s = yield* Recurrences;
        const core = yield* Core;
        const due = yield* collect;
        const got = core.state().recurrences ?? [];
        expect([got.length, got[1]?.enabled, got[1]?.agent]).toEqual([2, false, "lab"]);
        clock.now += 60 * 60_000;
        const on = yield* s.setEnabled(everyId, true);
        expect(on.lastRun).toBe(clock.now);
        yield* s.tick;
        clock.now += 60 * 60_000;
        yield* s.tick;
        yield* drained;
        expect(due.map((d) => [d.recurrence.id, d.missed])).toEqual([[everyId, true]]);
        yield* s.remove(everyId);
        expect((yield* Effect.flip(s.remove(everyId)))._tag).toBe("Missing");
        expect(core.state().recurrences).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(farm(config, clock)));
    });
  });

  it.live("a run that cannot be written is not published, and runs on the next tick", () => {
    const clock = { now: 1_800_000_000_000 };
    return Effect.gen(function* () {
      const s = yield* Recurrences;
      const core = yield* Core;
      const sql = yield* SqlClient.SqlClient;
      const made = yield* s.add(req("retry", "work", { kind: "once", at: clock.now + 1 }), "owner", true);
      const due = yield* collect;
      yield* sql.unsafe(`create function fail_run() returns trigger language plpgsql as $$ begin raise exception 'write failed'; end $$`).pipe(Effect.orDie);
      yield* sql.unsafe(`create trigger fail_run before update of last_run on recurrence for each row execute function fail_run()`).pipe(Effect.orDie);
      clock.now++;
      yield* s.tick;
      yield* drained;
      const after = (core.state().recurrences ?? []).find((x) => x.id === made.id)!;
      expect([after.enabled, after.lastRun, due]).toEqual([true, undefined, []]);
      yield* sql.unsafe(`drop trigger fail_run on recurrence`).pipe(Effect.orDie);
      yield* s.tick;
      yield* drained;
      expect(due.map((d) => d.recurrence.id)).toEqual([made.id]);
    }).pipe(Effect.scoped, Effect.provide(farm(testConfig(), clock)));
  });

  it.live("weekly days are integers from zero to six", () => {
    const clock = { now: Date.now() };
    return Effect.gen(function* () {
      const s = yield* Recurrences;
      const bad = req(" fractional ", "work", { kind: "weekly", days: [1.5], time: "09:00" });
      expect((yield* Effect.flip(s.add(bad, "owner", true)))._tag).toBe("Refused");
      expect(s.list()).toEqual([]);
      expect(Schema.decodeUnknownExit(RecurrenceWhenWeekly)(bad.when)._tag).toBe("Failure");
      expect((yield* s.add(req("weekly", "work", { kind: "weekly", days: [0, 6], time: "09:00" }), "owner", true)).when).toEqual({
        kind: "weekly",
        days: [0, 6],
        time: "09:00",
      });
    }).pipe(Effect.scoped, Effect.provide(farm(testConfig(), clock)));
  });

  it.live("a cron recurrence is kept, and a bad one is refused", () => {
    const config = { ...testConfig(), db: "" };
    const clock = { now: Date.now() };
    let id = "";
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const s = yield* Recurrences;
        id = (yield* s.add(req("早会", "看看昨天的活", { kind: "cron", expr: "0 9 * * 1-5" }, { tz: "Asia/Shanghai" }), "owner", true)).id;
        expect((yield* Effect.flip(s.add(req("坏的", "t", { kind: "cron", expr: "0 9 * *" }), "owner", true)))._tag).toBe("Refused");
      }).pipe(Effect.scoped, Effect.provide(farm(config, clock)));
      yield* Effect.gen(function* () {
        expect((yield* Recurrences).list().map((x) => [x.id, x.when])).toEqual([[id, { kind: "cron", expr: "0 9 * * 1-5" }]]);
      }).pipe(Effect.scoped, Effect.provide(farm(config, clock)));
    });
  });

  it.live("a stored recurrence with the wrong spec is not restored beside a valid one", () => {
    const config = { ...testConfig(), db: "" };
    const clock = { now: Date.now() };
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const channel = (yield* Channels).general();
        for (const [id, spec] of [
          ["bad-spec", `{"kind":"weekly","days":[1.5],"time":"09:00"}`],
          ["good", `{"kind":"daily","time":"09:00"}`],
        ] as const)
          yield* Effect.orDie(
            q.addRecurrence({
              id,
              name: id,
              body: "",
              channel_id: channel,
              agent: null,
              project: null,
              spec,
              tz: "UTC",
              pending: false,
              set_by: "owner",
              created_at: 0,
            }),
          );
      }).pipe(Effect.scoped, Effect.provide(farm(config, clock)));
      yield* Effect.gen(function* () {
        expect((yield* Recurrences).list().map((r) => [r.id, r.when, r.by])).toEqual([["good", { kind: "daily", time: "09:00" }, "owner"]]);
      }).pipe(Effect.scoped, Effect.provide(farm(config, clock)));
    });
  });

  it.live("one the orchestrator set alone waits for the owner's yes, through restarts", () => {
    const config = { ...testConfig(), db: "" };
    const clock = { now: 1_800_000_000_000 };
    let id = "";
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const s = yield* Recurrences;
        const made = yield* s.add(req("每五分钟", "看看", { kind: "every", minutes: 5 }), "orchestrator", false);
        expect([made.enabled, made.pending, made.by, nextText(made)]).toEqual([false, true, "orchestrator", "等主人同意"]);
        id = made.id;
        const due = yield* collect;
        clock.now += 10 * 60_000;
        yield* s.tick;
        yield* drained;
        expect(due).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(farm(config, clock)));
      yield* Effect.gen(function* () {
        const s = yield* Recurrences;
        expect(s.list().map((x) => [x.enabled, x.pending, x.by])).toEqual([[false, true, "orchestrator"]]);
        const on = yield* s.setEnabled(id, true);
        expect([on.enabled, on.pending]).toEqual([true, undefined]);
      }).pipe(Effect.scoped, Effect.provide(farm(config, clock)));
      yield* Effect.gen(function* () {
        const s = yield* Recurrences;
        const due = yield* collect;
        expect(s.list().map((x) => [x.enabled, x.pending])).toEqual([[true, undefined]]);
        clock.now += 5 * 60_000;
        yield* s.tick;
        yield* drained;
        expect(due.map((d) => d.recurrence.id)).toEqual([id]);
      }).pipe(Effect.scoped, Effect.provide(farm(config, clock)));
    });
  });
});
