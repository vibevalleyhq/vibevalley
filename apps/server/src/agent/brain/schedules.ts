// What the agent set itself to do later, in schedules.json in its home. One missed while the agent was away runs once
// when it is back, not once per miss. Cron is in the machine's time zone.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Cron, Result } from "effect";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { numberSchema, objectSchema, stringSchema, textTool } from "./tool.ts";

export interface Job {
  readonly id: string;
  readonly name: string;
  readonly message: string;
  /** One of: a cron expression, a moment (ISO), every so many minutes. */
  readonly cron?: string;
  readonly at?: string;
  readonly everyMinutes?: number;
  readonly created: string;
  readonly lastRun?: string;
}

const parseDate = (text: string) => {
  const d = new Date(text.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export function parseCron(expr: string): Cron.Cron {
  const parsed = Cron.parse(expr);
  if (Result.isFailure(parsed)) throw new Error(`cron 写得不对（${parsed.failure.message}）：五段，分 时 日 月 周，比如 0 9 * * 1-5 是工作日早上九点。`);
  return parsed.success;
}

export function nextRun(job: Job): Date | undefined {
  const from = parseDate(job.lastRun || job.created) ?? new Date(0);
  if (job.at) return job.lastRun ? undefined : parseDate(job.at);
  if (job.everyMinutes) return new Date(from.getTime() + job.everyMinutes * 60_000);
  if (job.cron) {
    try {
      // Effect's Cron starts at the second after from.
      return Cron.next(parseCron(job.cron), from);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const dueJobs = (jobs: readonly Job[], now: Date) =>
  jobs.filter((j) => {
    const next = nextRun(j);
    return next !== undefined && next.getTime() <= now.getTime();
  });

const pad = (n: number) => String(n).padStart(2, "0");
/** toLocaleString('zh-CN', { hour12: false }). */
const localeTime = (t: Date) => `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;

/** To the minute: what an input says the time is, so that it does not change between two requests a few seconds apart. */
export const localeMinute = (t: Date) => `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}`;

export function describeJob(j: Job): string {
  const when = j.at ? localeTime(parseDate(j.at) ?? new Date(0)) + " 一次" : j.everyMinutes ? `每 ${j.everyMinutes} 分钟` : "cron " + j.cron;
  const next = nextRun(j);
  return "- " + j.id + "「" + j.name + "」" + when + "；下次 " + (next ? localeTime(next) : "（不会再跑）") + "\n  " + j.message;
}

export const dueMessage = (j: Job) => "【定时任务「" + j.name + "」到点了（" + j.id + "）】\n" + j.message;

export class Schedules {
  readonly tools: AgentTool[];
  private readonly file: string;

  constructor(
    private readonly home: string,
    private readonly wake: (text: string) => void,
  ) {
    this.file = join(home, "schedules.json");
    this.tools = this.makeTools();
  }

  private load(): Job[] {
    if (!existsSync(this.file)) return [];
    return JSON.parse(readFileSync(this.file, "utf8")) as Job[];
  }

  private store(jobs: readonly Job[]) {
    mkdirSync(this.home, { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(jobs));
    renameSync(this.file + ".tmp", this.file);
  }

  /** At most once each. */
  tick(now = new Date()) {
    let due: Job[];
    try {
      const jobs = this.load();
      due = dueJobs(jobs, now);
      const isDue = new Set(due.map((j) => j.id));
      this.store(jobs.flatMap((j) => (!isDue.has(j.id) ? [j] : j.at ? [] : [{ ...j, lastRun: now.toISOString() }])));
    } catch (e) {
      console.error("agent: cannot claim due schedules:", e);
      return;
    }
    for (const j of due) this.wake(dueMessage(j));
  }

  private makeTools(): AgentTool[] {
    const add = textTool<{ name: string; message: string; at?: string; every_minutes?: number; cron?: string }>({
      name: "schedule",
      description:
        "定一个以后要做的事：到点时你会收到 message，像有人对你说的一样，然后去做。三选一：at（某个时刻，ISO 时间，比如 2026-10-13T09:00:00+08:00）、every_minutes（每隔几分钟）、cron（五段：分 时 日 月 周，本机时区）。message 写清楚到时候要做什么、做完告诉谁。",
      parameters: objectSchema(
        { name: stringSchema(), message: stringSchema(), at: stringSchema(), every_minutes: numberSchema(), cron: stringSchema() },
        "name",
        "message",
      ),
      run: (p) => {
        if ([p.at, p.every_minutes, p.cron].filter((x) => x !== undefined && x !== null).length !== 1)
          throw new Error("at、every_minutes、cron 要正好给一个。");
        let at: Date | undefined;
        if (p.at != null) {
          at = parseDate(p.at);
          if (!at) throw new Error(`at 不是一个时间：${p.at}。用 ISO 格式，带时区。`);
        }
        if (p.every_minutes != null && !(p.every_minutes >= 1)) throw new Error("every_minutes 至少是 1。");
        if (p.cron != null) parseCron(p.cron);
        const now = new Date();
        const job: Job = {
          id: "job-" + now.getTime().toString(36),
          name: p.name,
          message: p.message,
          ...(p.cron != null ? { cron: p.cron } : {}),
          ...(at ? { at: at.toISOString() } : {}),
          ...(p.every_minutes != null ? { everyMinutes: p.every_minutes } : {}),
          created: now.toISOString(),
        };
        this.store([...this.load(), job]);
        return "定好了：\n" + describeJob(job);
      },
    });
    const list = textTool<object>({
      name: "list_schedules",
      description: "列出定好的事。",
      parameters: objectSchema(),
      run: () => {
        const jobs = this.load();
        return jobs.length === 0 ? "没有定好的事。" : jobs.map(describeJob).join("\n");
      },
    });
    const cancel = textTool<{ id: string }>({
      name: "cancel_schedule",
      description: "取消一件定好的事（id 从 list_schedules 看）。",
      parameters: objectSchema({ id: stringSchema() }, "id"),
      run: (p) => {
        const jobs = this.load();
        const j = jobs.find((x) => x.id === p.id);
        if (!j) throw new Error(`没有 ${p.id}：先 list_schedules 看看。`);
        this.store(jobs.filter((x) => x !== j));
        return "取消了「" + j.name + "」。";
      },
    });
    return [add, list, cancel];
  }
}
