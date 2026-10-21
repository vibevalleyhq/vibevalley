// How the tools word what they found.

import type { Changes, Schedule, Spent, UncommittedItem } from "@vibevalley/protocol";
import { head, nextText, phaseText, runtimeLabel, whenText, yuan } from "@vibevalley/protocol/rules";
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

/** How a session reads to the manager, in its situation as in roster. */
export function sessionLine(w: Roster, now = Date.now()): string {
  const h = w.session;
  let last = "";
  if (h.lastRun) {
    const how = h.lastRun.outcome === "completed" ? "做完了" : h.lastRun.outcome === "failed" ? "失败了" : "停下了";
    last = "；上一轮" + how + "：" + head(h.lastRun.summary, 80);
  }
  const where = w.place.branch ? "在 " + w.place.project + " 的 " + w.place.branch : "在 " + w.place.project;
  const task = h.graph ? (h.graph.task ? "，做计划 " + h.graph.id + " 的步骤 " + h.graph.task : "，在拆计划 " + h.graph.id) : "";
  const spent = h.spent ? "；花了" + spentText(h.spent) : "";
  return `- ${h.name}（${h.id}，${runtimeLabel(h.runtime)}，${where}${task}）工单「${head(h.brief, 60)}」，${phaseText(h, now)}${last}${spent}`;
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

/** A task starts many helpers at once and spends for each: only the owner's words start one, as with a merge. */
export const startNotAsked = "没开工：计划开工要主人点头。这一轮不是主人叫你的：把拆好的计划给主人看，问要不要开工。";
