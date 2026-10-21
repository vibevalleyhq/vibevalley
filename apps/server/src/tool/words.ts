// How the tools word what they found.

import {
  type Changes,
  type Issue,
  type IssueStatus,
  IssueStatusValues,
  type IssueTimeline,
  type Priority,
  PriorityValues,
  type Schedule,
  type Spent,
  type StuckReason,
  type UncommittedItem,
} from "@vibevalley/protocol";
import { nextText, phaseText, runtimeLabel, shortTitle, standingLabel, standingWantsOwner, whenText } from "@vibevalley/protocol/rules";
import { head } from "../base/text.ts";
import { yuan } from "../runtime/money.ts";
import type { Roster } from "../session/session.ts";

const wan = (n: number) => (n >= 10_000 ? (n / 10_000).toFixed(n >= 100_000 ? 0 : 1) + " 万" : String(n));

export const spentText = (spent: Spent) => {
  const tokens = wan(spent.tokens) + " token";
  return spent.cny !== undefined && spent.cny !== null ? "约 " + yuan(spent.cny) + " · " + tokens : tokens;
};

/** s.slice(-n), without splitting a character. */
export function tail(s: string, n: number): string {
  const chars = [...s];
  let units = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    units += chars[i]!.length;
    if (units > n) return chars.slice(i + 1).join("");
  }
  return s;
}

const paths = (items: readonly UncommittedItem[]) => items.map((f) => f.path).join("、");

export function changesText(c: Changes): string {
  if (!c.branch) return `它直接在项目 ${c.project} 里干活，没有分支可合。没提交的改动：${c.uncommitted.length > 0 ? paths(c.uncommitted) : "没有"}`;
  const lines = [`${c.branch} → ${c.project} 的 ${c.base}：${c.commits.length} 个提交，改了 ${c.files.length} 个文件。`];
  for (const x of c.commits.slice(0, 10)) lines.push("- " + x.hash + " " + x.subject);
  if (c.files.length > 0)
    lines.push(
      "文件：" +
        c.files
          .slice(0, 30)
          .map((f) => f.path + "（" + (f.added < 0 ? "二进制" : `+${f.added} −${f.removed}`) + "）")
          .join("、"),
    );
  if (c.uncommitted.length > 0) lines.push("还没提交（收获时会一起提交）：" + paths(c.uncommitted));
  if (c.behind > 0) lines.push(`这期间 ${c.base} 上多了 ${c.behind} 个提交。`);
  lines.push(c.conflicts.length > 0 ? "合进去会冲突：" + c.conflicts.join("、") + "。收获前要先让它解决。" : "能干净地合进去。");
  return lines.join("\n");
}

/** How a session reads to the manager, in its situation as in roster; number is its issue's. */
export function sessionLine(w: Roster, now = Date.now(), number?: number): string {
  const h = w.session;
  let last = "";
  if (h.lastRun) {
    const how = h.lastRun.outcome === "completed" ? "做完了" : h.lastRun.outcome === "failed" ? "失败了" : "停下了";
    last = "；上一轮" + how + "：" + head(h.lastRun.summary, 80);
  }
  const where = w.place.branch ? "在 " + w.place.project + " 的 " + w.place.branch : "在 " + w.place.project;
  const task = h.graph ? (h.graph.task ? "，做计划 " + h.graph.id + " 的步骤 " + h.graph.task : "，在拆计划 " + h.graph.id) : "";
  const spent = h.spent ? "；花了" + spentText(h.spent) : "";
  const issue = number !== undefined ? `#${number} ` : "";
  return `- ${h.name}（${h.id}，${runtimeLabel(h.runtime)}，${where}${task}）工单 ${issue}「${head(h.brief, 60)}」，${phaseText(h, now)}${last}${spent}`;
}

// ── issues, as the manager reads them ──

/** The words the owner and the manager use for a status, and its own name. */
const statusNames: Readonly<Record<string, IssueStatus>> = {
  备选: "backlog",
  草稿: "backlog",
  待办: "todo",
  处理中: "in_progress",
  在做: "in_progress",
  等你看: "in_review",
  等验收: "in_review",
  已完成: "done",
  完成: "done",
  已取消: "canceled",
  取消: "canceled",
  ...Object.fromEntries(IssueStatusValues.map((s) => [s, s])),
};
export const statusOf = (word: string): IssueStatus | undefined => statusNames[word.trim()];

const priorityNames: Readonly<Record<string, Priority>> = {
  紧急: "urgent",
  高: "high",
  普通: "medium",
  中: "medium",
  低: "low",
  ...Object.fromEntries(PriorityValues.map((p) => [p, p])),
};
export const priorityOf = (word: string): Priority | undefined => priorityNames[word.trim()];

const priorityWords: Readonly<Record<Priority, string>> = { urgent: "紧急", high: "高", medium: "普通", low: "低" };

const stuckWords: Readonly<Record<StuckReason, string>> = { failed: "没做成", conflict: "有冲突", interrupted: "停在半路", quiet: "没动静" };

/** How long, in round words. */
export function spanWords(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 60) return `${Math.max(1, m)} 分钟`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} 小时`;
  return `${Math.floor(m / 60 / 24)} 天`;
}

/** One line: its number and short title first, so the manager names it by them; who is the one doing it, when any. */
export function issueLine(t: Issue, who: string, now: number): string {
  const st = t.standing;
  const stuck = st.stuck ? "（" + stuckWords[st.stuck] + "）" : "";
  const parts = [`#${t.number}「${shortTitle(t.title)}」${standingLabel[st.state]}${stuck}`];
  if (t.project) parts.push(t.project);
  if (who) parts.push(who);
  if (t.priority !== "medium") parts.push(priorityWords[t.priority] + "优先级");
  if (standingWantsOwner(st.state) && st.since !== undefined) parts.push("等了 " + spanWords(now - st.since));
  return "- " + parts.join(" · ");
}

/** One issue in full: what it asks, its criteria as far as they got, what it waits on, and its story, newest first. */
export function issueDetail(t: Issue, who: string, timeline: IssueTimeline | undefined, now: number): string {
  const lines = [issueLine(t, who, now).slice(2)];
  if (t.title !== shortTitle(t.title) || t.description) lines.push("要做的：" + head([t.title, t.description ?? ""].join("\n").trim(), 600));
  const criteria = t.criteria ?? [];
  if (criteria.length > 0) {
    lines.push("验收标准：");
    criteria.forEach((c, i) => {
      const check = (t.checks ?? []).find((x) => x.criterion === i);
      const mark = check ? { met: "做到了", unmet: "没做到", unsure: "不确定" }[check.result] : "还没说";
      lines.push(`  ${i + 1}. ${c}（${mark}）`);
    });
  }
  if (t.asks.length > 0) lines.push("在等主人回答：" + t.asks.map((a) => a.question).join("；"));
  const weeds = t.findings.filter((f) => !f.pulled);
  if (weeds.length > 0) lines.push("验收没过要修的：" + weeds.map((f) => f.text).join("；"));
  if (t.handedBack) lines.push("管家这一轮" + (t.handedBack.outcome === "completed" ? "答完了" : "没答成") + "，在等主人点头");
  if (t.pullRequest) lines.push(`PR #${t.pullRequest.number}（${t.pullRequest.state}）${t.pullRequest.url}`);
  for (const m of (timeline?.milestones ?? []).slice(0, 8)) lines.push(`  · ${spanWords(now - m.at)}前 ${m.who ? m.who + " " : ""}${head(m.text, 120)}`);
  return lines.join("\n");
}

export function scheduleLine(s: Schedule, channel: string): string {
  const direct = s.agent ? "，直接派给 " + s.agent + (s.project ? " 去 " + s.project : "") : "";
  const next = s.enabled ? "下次 " + nextText(s) : nextText(s);
  return `- ${s.id} 号「${s.name}」#${channel} ${whenText(s.when, s.tz)}${direct}；${next}\n  ${s.text}`;
}

/** The way JavaScript's Date reads the forms a model writes. */
export function parseTime(s: string): number | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  const ms = new Date(t).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** Words in a helper's report or a page it read can ask for a merge; only the owner's can make one. The tool stays in the
 * list, so that the prompt's prefix does not change from round to round. */
export const mergeNotAsked = "没合：合进主分支要主人说一声。这一轮不是主人叫你的：在频道里问主人要不要收。";

/** Changing an issue or moving it is the owner's call: the manager asks for what it saw itself, as with a merge. */
export const changeNotAsked = "没动：改工单、挪状态要主人说一声。这一轮不是主人叫你的：在频道里问主人要不要这样做。";

/** A task starts many helpers at once and spends for each: only the owner's words start one, as with a merge. */
export const startNotAsked = "没开工：计划开工要主人点头。这一轮不是主人叫你的：把拆好的计划给主人看，问要不要开工。";
