// What a session is doing and what it waits on.

import type { Conflict, Retry, Session } from "../shapes";
import { actionText } from "./seeds";

/** It takes one of the places for those working at once. */
export const isBusy = (h: Session) => h.phase._tag === "arriving" || h.phase._tag === "working";

export type Need =
  | { readonly kind: "quiet"; readonly since: number }
  | { readonly kind: "retrying"; readonly retry: Retry }
  | { readonly kind: "conflict"; readonly conflict: Conflict }
  | { readonly kind: "harvest" }
  | { readonly kind: "fix" };

export function needOf(h: Session): Need | undefined {
  const p = h.phase;
  switch (p._tag) {
    case "working":
      if (p.quietSince !== undefined) return { kind: "quiet", since: p.quietSince };
      if (p.retry !== undefined) return { kind: "retrying", retry: p.retry };
      return undefined;
    case "ripe":
      return h.conflict ? { kind: "conflict", conflict: h.conflict } : { kind: "harvest" };
    case "failed":
      return { kind: "fix" };
    case "resting":
      return h.conflict ? { kind: "conflict", conflict: h.conflict } : undefined;
    default:
      return undefined;
  }
}

const span = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60_000)} 分钟`);

/** The span placeholder in phaseWords. */
const phaseSpan = "{span}";

/** phaseWords as said at now. */
export function phaseText(h: Session, now: number): string {
  const words = phaseWords(h);
  const need = needOf(h);
  return need?.kind === "quiet" ? words.replaceAll(phaseSpan, span(now - need.since)) : words;
}

/** What a session is doing in words, how long it has been quiet left as {span}. */
export function phaseWords(h: Session): string {
  const need = needOf(h);
  const conflict = need?.kind === "conflict" ? `，合进 ${need.conflict.base} 会冲突（${(need.conflict.files ?? []).join("、")}）` : "";
  const p = h.phase;
  switch (p._tag) {
    case "arriving":
      return "刚派出去，正在开工";
    case "working": {
      let what = "在" + (actionText[p.doing.action] ?? "");
      if (p.doing.label !== "") what += "：" + p.doing.label;
      if (need?.kind === "quiet") return what + "（已经 " + phaseSpan + "没动静了）";
      if (need?.kind === "retrying") {
        const of = need.retry.of ? `/${need.retry.of}` : "";
        return `${what}（模型调用失败，在重试第 ${need.retry.attempt}${of} 次）`;
      }
      return what;
    }
    case "ripe":
      return "这一轮做完了，等收获" + conflict;
    case "failed":
      return "这一轮失败了";
    case "resting": {
      const outcome = h.lastRun?.outcome;
      const last = outcome === undefined ? "没做完" : outcome === "interrupted" ? "被叫停" : outcome === "completed" ? "做完了" : "失败了";
      return "歇着（上一轮" + last + "）" + conflict;
    }
    default:
      return "";
  }
}
