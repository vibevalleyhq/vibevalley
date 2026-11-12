import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import { CronWhenWeekly } from "@vibevalley/protocol/schema";

import { orchestrator, user } from "#/base/actor.ts";
import { type ServerConfig } from "#/infra/config.ts";
import { testConfig } from "#/testing/layers.ts";
import { allow, refuse } from "#/testing/refuse.ts";
import { world } from "#/testing/world.ts";
import * as q from "#db/cron.sql.ts";

import type { Cron, Due } from "./cron.ts";
import { afterRun, dueCrons, isMissed, needsOK, nextText } from "./when.ts";

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
    by: "user",
  } as T.Cron;
  const now = at("2026-10-12T11:00:00");
  expect(dueCrons([s], now)).toEqual([s]);
  expect(isMissed(s, now)).toBe(true);
  expect(dueCrons([afterRun(s, now)], now)).toEqual([]);
  expect(isMissed(s, at("2026-10-10T09:00:20"))).toBe(false);
  expect(afterRun({ ...s, when: { kind: "once", at: at("2026-10-12T12:00:00") } }, now).enabled).toBe(false);
});

test("what waits for the user's yes", () => {
  const once: T.CronWhen = { kind: "once", at: at("2026-10-12T12:00:00") };
  const daily: T.CronWhen = { kind: "daily", time: "09:00" };
  const req = (when: T.CronWhen, agent?: string) => ({ name: "", text: "", when, ...(agent !== undefined ? { agent } : {}) }) as T.CronRequest;
  expect(needsOK(req(daily, "lab"), user)).toBe(false);
  expect(needsOK(req(daily, "lab"), orchestrator(true))).toBe(false);
  expect(needsOK(req(once), orchestrator(false))).toBe(false);
  expect(needsOK(req(daily), orchestrator(false))).toBe(true);
  expect(needsOK(req(once, "lab"), orchestrator(false))).toBe(true);
  expect(needsOK(req(once, " "), orchestrator(false))).toBe(false);
});

/** The farm with crons on a clock turned by hand. */
const farm = (config: ServerConfig) => world({ config });

/** What came due since: a tick publishes before it returns, so what is waiting is all of it. */
const collect = (cron: Cron) => {
  const sub = cron.due();
  const got: Due[] = [];
  return () => {
    got.push(...sub.drain());
    return got;
  };
};

const flip = (p: Promise<unknown>) =>
  p.then(
    () => expect.unreachable("it was refused"),
    (e: unknown) => e,
  );

const req = (name: string, text: string, when: T.CronWhen, more: Partial<T.CronRequest> = {}): T.CronRequest => ({ name, text, when, ...more });

/** The test's clock: vitest's fake timers move the wall clock the farm reads. */
const setTime = (ms: number) => vi.setSystemTime(ms);
const adjust = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("crons", () => {
  test("come due, are kept, and come back on", async () => {
    const config = { ...testConfig(), db: "" };
    const now = Date.UTC(2026, 9, 13, 8);
    let everyId = "";
    setTime(now);
    {
      await using f = await farm(config);
      const { cron: s, core, channel: chat } = f;
      const due = collect(s);
      const general = chat.defaultChannel();
      const made = await s.add(req(" 看进度 ", "看看帮工们的进度", { kind: "once", at: now + 150 }), user);
      expect([made.channel, made.name, made.enabled, made.tz !== ""]).toEqual([general, "看进度", true, true]);
      expect(core.state().crons.map((x) => x.id)).toEqual([made.id]);
      await s.tick();
      expect(due()).toEqual([]);
      await adjust(200);
      await s.tick();
      expect(due().map((d) => [d.cron.id, d.missed, d.cron.enabled])).toEqual([[made.id, false, false]]);
      expect((await chat.history(general)).some((message) => message.text.includes("⏰"))).toBe(false);
      expect(s.list()[0]!.enabled).toBe(false);
      await s.tick();
      const addedFailure = await flip(s.add(req("x", "y", { kind: "every", minutes: 5 }, { agent: "lab" }), user));
      expect(addedFailure).toMatchObject({
        message: expect.stringContaining("默认仓库"),
      });
      const addedFailure2 = await flip(s.add(req("x", "y", { kind: "every", minutes: 5 }, { agent: "nobody" }), user));
      expect(addedFailure2).toMatchObject({
        message: expect.stringContaining("没有叫 nobody"),
      });
      const addedFailure3 = await flip(s.add(req("x", "y", { kind: "every", minutes: 5 }, { channel: "elsewhere" }), user));
      // A channel is named as the user names it: one there is not is not found.
      expect(addedFailure3).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelNotFound, message: expect.stringContaining("elsewhere") });
      const every = await s.add(req("巡检", "跑一遍检查", { kind: "every", minutes: 5 }, { agent: "lab", repo: "demo" }), user);
      expect([every.agent, every.repo]).toEqual(["lab", "demo"]);
      everyId = every.id;
      await s.setEnabled(every.id, false);
    }
    {
      await using f = await farm(config);
      const { cron: s, core } = f;
      const due = collect(s);
      const got = core.state().crons;
      expect([got.length, got[1]?.enabled, got[1]?.agent]).toEqual([2, false, "lab"]);
      await adjust(60 * 60_000);
      const on = await s.setEnabled(everyId, true);
      const now = Date.now();
      expect(on.lastRun).toBe(now);
      await s.tick();
      await adjust(60 * 60_000);
      await s.tick();
      expect(due().map((d) => [d.cron.id, d.missed])).toEqual([[everyId, true]]);
      await s.remove(everyId);
      expect(await flip(s.remove(everyId))).toMatchObject({ bizCode: BizCode.CronNotFound });
      expect(core.state().crons).toHaveLength(1);
    }
  });

  test("weekly days are integers from zero to six", async () => {
    const now = 1_800_000_000_000;
    setTime(now);
    await using f = await farm(testConfig());
    const s = f.cron;
    const bad = req(" fractional ", "work", { kind: "weekly", days: [1.5], time: "09:00" });
    expect(await flip(s.add(bad, user))).toMatchObject({ bizCode: BizCode.CronRefused });
    expect(s.list()).toEqual([]);
    expect(CronWhenWeekly.safeParse(bad.when).success).toBe(false);
    expect((await s.add(req("weekly", "work", { kind: "weekly", days: [0, 6], time: "09:00" }), user)).when).toEqual({
      kind: "weekly",
      days: [0, 6],
      time: "09:00",
    });
  });

  test("a cron cron is kept, and a bad one is refused", async () => {
    const config = { ...testConfig(), db: "" };
    const now = 1_800_000_000_000;
    let id = "";
    setTime(now);
    {
      await using f = await farm(config);
      const s = f.cron;
      id = (await s.add(req("早会", "看看昨天的活", { kind: "cron", expr: "0 9 * * 1-5" }, { tz: "Asia/Shanghai" }), user)).id;
      expect(await flip(s.add(req("坏的", "t", { kind: "cron", expr: "0 9 * *" }), user))).toMatchObject({ bizCode: BizCode.CronRefused });
    }
    {
      await using f = await farm(config);
      expect(f.cron.list().map((x) => [x.id, x.when])).toEqual([[id, { kind: "cron", expr: "0 9 * * 1-5" }]]);
    }
  });

  test("a stored cron with the wrong spec is not restored beside a valid one", async () => {
    const config = { ...testConfig(), db: "" };
    const now = 1_800_000_000_000;
    setTime(now);
    {
      await using f = await farm(config);
      const channel = f.channel.defaultChannel();
      for (const [id, spec] of [
        ["bad-spec", `{"kind":"weekly","days":[1.5],"time":"09:00"}`],
        ["good", `{"kind":"daily","time":"09:00"}`],
      ] as const)
        await q.addCron(f.db.sql, {
          id,
          name: id,
          body: "",
          channel_id: channel,
          agent: null,
          repo: null,
          spec,
          tz: "UTC",
          pending: false,
          set_by: "user",
          created_at: 0,
        });
    }
    {
      await using f = await farm(config);
      expect(f.cron.list().map((r) => [r.id, r.when, r.by])).toEqual([["good", { kind: "daily", time: "09:00" }, "user"]]);
    }
  });

  test("one the orchestrator set alone waits for the user's yes, through restarts", async () => {
    const config = { ...testConfig(), db: "" };
    const now = 1_800_000_000_000;
    let id = "";
    setTime(now);
    {
      await using f = await farm(config);
      const s = f.cron;
      const made = await s.add(req("每五分钟", "看看", { kind: "every", minutes: 5 }), orchestrator(false));
      expect([made.enabled, made.pending, made.by, nextText(made)]).toEqual([false, true, "agent", "等你同意"]);
      id = made.id;
      const due = collect(s);
      await adjust(10 * 60_000);
      await s.tick();
      expect(due()).toEqual([]);
    }
    {
      await using f = await farm(config);
      const s = f.cron;
      expect(s.list().map((x) => [x.enabled, x.pending, x.by])).toEqual([[false, true, "agent"]]);
      const on = await s.setEnabled(id, true);
      expect([on.enabled, on.pending]).toEqual([true, false]);
    }
    {
      await using f = await farm(config);
      const s = f.cron;
      const due = collect(s);
      expect(s.list().map((x) => [x.enabled, x.pending])).toEqual([[true, false]]);
      await adjust(5 * 60_000);
      await s.tick();
      expect(due().map((d) => d.cron.id)).toEqual([id]);
    }
  });
});

test("regression: a cron occurrence and its schedule advance commit together", async () => {
  const config = testConfig();
  const now = 1_800_000_000_000;
  setTime(now);
  await using f = await farm(config);
  const crons = f.cron;
  const sql = f.db.sql;
  const item = await crons.add(req("atomic", "work", { kind: "once", at: now + 1 }), user);
  await refuse(f.db, "reject_cron_input", "before insert on mailbox_trigger", "new.source = 'cron'", "rejected input");
  await adjust(2);
  await crons.tick();
  const rows = await sql.query("select enabled, last_run from cron where id = $1", [item.id]);
  expect(rows).toEqual([{ enabled: true, last_run: null }]);
  const rows2 = await sql.query("select id from mailbox_trigger where source = 'cron'");
  expect(rows2).toEqual([]);
  await allow(f.db, "reject_cron_input");
  await crons.tick();
  expect((await sql.query("select id from mailbox_trigger where source = 'cron'")).length).toBe(1);
});

test("regression: a one-off cron resumes committed input after restart without a second issue", async () => {
  const config = { ...testConfig(), db: "" };
  const now = 1_800_000_000_000;
  setTime(now);
  {
    await using f = await farm(config);
    const crons = f.cron;
    const sql = f.db.sql;
    await crons.add(req("restart-once", "work", { kind: "once", at: now + 1 }), user);
    await refuse(f.db, "reject_cron_issue", "before insert on issue", "", "rejected issue");
    await adjust(2);
    await crons.tick();
    const rows = await sql.query("select enabled from cron");
    expect(rows).toEqual([{ enabled: false }]);
    const rows2 = await sql.query("select routed_at from mailbox_trigger where source = 'cron'");
    expect(rows2).toEqual([{ routed_at: null }]);
    await allow(f.db, "reject_cron_issue");
  }
  {
    await using f = await farm(config);
    const crons = f.cron;
    const sql = f.db.sql;
    await crons.tick();
    await crons.tick();
    const rows = await sql.query("select title from issue");
    expect(rows).toEqual([{ title: "restart-once" }]);
    const rows2 = await sql.query("select routed_at is not null as routed from mailbox_trigger where source = 'cron'");
    expect(rows2).toEqual([{ routed: true }]);
  }
});
