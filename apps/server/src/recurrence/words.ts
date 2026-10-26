// What the recurrences (定时) say to the owner: when one runs and when next, why one is refused, the line a due one
// leaves in its channel, and what is wrong with a cron expression.

import { localized } from "@vibevalley/protocol/words";

const zh = {
  /** Sunday first, as Date.getDay and cron have them. */
  weekdays: ["日", "一", "二", "三", "四", "五", "六"],
  when: {
    once: (clock: string) => clock + " 一次",
    hours: (n: number) => "每 " + String(n) + " 小时",
    minutes: (n: number) => "每 " + String(n) + " 分钟",
    daily: (time: string) => "每天 " + time,
    weekly: (days: readonly string[], time: string) => "每周" + days.join("、") + " " + time,
    weekdays: (time: string) => "工作日 " + time,
    weekend: (time: string) => "周末 " + time,
    monthly: (day: number, time: string) => "每月 " + day + " 号 " + time,
    hourly: (minute: number) => "每小时第 " + minute + " 分",
    cron: (expr: string) => "cron " + expr,
  },
  next: { never: "不会再到点", pending: "等主人同意", done: "做过了", off: "关着" },
  cron: {
    fields: ["分钟", "小时", "日", "月", "周几"],
    badField: (name: string, field: string) => "cron 的" + name + "写错了：" + field,
    fiveFields: "cron 要五段：分 时 日 月 周几，比如 0 9 * * 1-5",
    never: (expr: string) => "这个 cron 永远不会到点：" + expr,
  },
  problem: {
    noName: "定时要有个名字",
    noText: "定时要写到点了做什么",
    zone: (tz: string) => "不认识这个时区：" + tz,
    past: "一次性的时间要在以后",
    every: (min: number) => `间隔至少 ${min} 分钟`,
    time: (time: string) => "时间写成 HH:MM，比如 09:00：" + time,
    days: "每周的哪几天：0 到 6，0 是周日",
    kind: "不认识这种定时",
  },
  /** The line a due recurrence leaves in its channel. */
  due: (name: string, missed: boolean, text: string) => "⏰ 定时「" + name + "」到点了" + (missed ? "（服务端没开着时错过的，补一次）" : "") + "：" + text,
  noRecurrence: (id: string) => `没有 ${id} 号定时`,
  noChannel: (name: string) => `没有 ${name} 这个频道`,
  noProfile: (name: string) => `没有叫 ${name} 的帮工档案`,
  noProject: (channel: string) => `#${channel} 没有默认项目：直接派给帮工的定时要写 project`,
  remove: (name: string, when: string) => `删掉定时「${name}」${when ? `（${when}）` : ""}：以后不再到点开工，它开过的工单留着`,
};

const en: typeof zh = {
  weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  when: {
    once: (clock) => "once at " + clock,
    hours: (n) => (n === 1 ? "every hour" : `every ${n} hours`),
    minutes: (n) => `every ${n} minutes`,
    daily: (time) => "every day at " + time,
    weekly: (days, time) => "every " + days.join(", ") + " at " + time,
    weekdays: (time) => "weekdays at " + time,
    weekend: (time) => "weekends at " + time,
    monthly: (day, time) => `on day ${day} of every month at ${time}`,
    hourly: (minute) => `every hour at minute ${minute}`,
    cron: (expr) => "cron " + expr,
  },
  next: { never: "never again", pending: "waiting for your approval", done: "done", off: "off" },
  cron: {
    fields: ["minute", "hour", "day", "month", "weekday"],
    badField: (name, field) => `the cron ${name} is wrong: ${field}`,
    fiveFields: "cron takes five fields: minute hour day month weekday, such as 0 9 * * 1-5",
    never: (expr) => "this cron never comes due: " + expr,
  },
  problem: {
    noName: "A schedule needs a name",
    noText: "A schedule needs what to do when it is due",
    zone: (tz) => "Unknown time zone: " + tz,
    past: "A one-off time must be in the future",
    every: (min) => `The interval is at least ${min} minutes`,
    time: (time) => "Write the time as HH:MM, such as 09:00: " + time,
    days: "Which days of the week: 0 to 6, 0 is Sunday",
    kind: "Unknown kind of schedule",
  },
  due: (name, missed, text) => `⏰ The schedule "${name}" is due` + (missed ? " (missed while the server was off, made up once)" : "") + ": " + text,
  noRecurrence: (id) => `There is no schedule ${id}`,
  noChannel: (name) => `There is no channel ${name}`,
  noProfile: (name) => `There is no helper profile called ${name}`,
  noProject: (channel) => `#${channel} has no default project: a schedule sent straight to a helper needs a project`,
  remove: (name, when) => `Delete the schedule "${name}"${when ? ` (${when})` : ""}: it no longer starts work when due; the tickets it opened stay`,
};

export const recurrenceWording = localized({ zh, en });
