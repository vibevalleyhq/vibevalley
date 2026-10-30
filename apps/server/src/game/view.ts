// What the farm draws of the core state: levels, plots,
// the effects a fact sets off, and the achievements in words.

import { t } from "@vibevalley/i18n";
import type {
  Achievement,
  AchievementStanding,
  AchievementTier,
  Badge,
  WorkspaceState,
  Crop,
  Fact,
  FarmLevel,
  FarmView,
  GameEffect,
  GameEffectAchievement,
  Issue,
  PlotView,
  Progress,
  Session,
} from "@vibevalley/protocol";
import { needOf, omitUndefined } from "@vibevalley/protocol/rules";

import { type AchievementDef, achievements } from "@/agent/seed.ts";
import { openFindings } from "@/issue/status.ts";
import { sessionOf } from "@/session/roster.ts";

import { playOf } from "./play.ts";

export const xpToNext = (level: number) => 10 * level;

export function levelForCommits(total: number): [level: number, xp: number] {
  let level = 1;
  let rest = Math.max(0, total);
  while (rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  return [level, rest];
}

export function farmLevelOf(state: WorkspaceState): FarmLevel {
  const [level, xp] = levelForCommits(state.commits?.total ?? 0);
  return { level, xp, need: xpToNext(level) };
}

/** FNV-1a, 32 bits, over the UTF-8 bytes. */
function fnv32a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h >>> 0;
}

/** The same session ripens to the same crop every time. */
const ripeCrop = (h: Session): Crop => (fnv32a(h.id) % 2 === 1 ? "carrot" : "wheat");

function growth(h: Session): Crop {
  const play = playOf(h);
  const since = play.runStartedAt ?? h.hiredAt;
  let crop: Crop = "sprout";
  for (const step of play.history) {
    if (step.at < since) continue;
    if (step.action === "edit_file" && crop === "sprout") crop = "leafy";
    else if (step.action === "run_command" && crop === "leafy") crop = "flowering";
  }
  return crop;
}

// Made when asked for: their words are the locale's of the moment.
const badgeRipe = (): Badge => ({ text: t("server.game.badge.ripe"), tone: "ripe" });
const badgeBugs = (): Badge => ({ text: t("server.game.badge.bugs"), tone: "bug" });
const badgeConflict = (): Badge => ({ text: t("shared.stuck.conflict"), tone: "bug" });
const badgeQuiet = (): Badge => ({ text: t("shared.stuck.quiet"), tone: "stuck" });
const badgeHalfway = (): Badge => ({ text: t("shared.stuck.interrupted"), tone: "stuck" });
const badgeRetrying = (): Badge => ({ text: t("server.game.badge.retrying"), tone: "stuck" });
const badgeRest = (): Badge => ({ text: t("server.game.badge.rest"), tone: "rest" });
const badgeReview = (): Badge => ({ text: t("shared.attention.reviewing"), tone: "wait" });
const badgeQuestions = (): Badge => ({ text: t("shared.attention.asking"), tone: "wait" });

/**
 * A plot is a picture of its issue's attention, never a second reading of it: the crop and the badge say where the
 * issue stands (attentionOf decides that, and in what order); the session only adds how far this round has grown.
 */
export function plotOf(h: Session, issue: Issue | undefined): PlotView {
  if (!issue) return plotOfSession(h);
  const a = issue.attention;
  switch (a.state) {
    case "draft":
    case "queued":
    case "working": {
      if (h.phase._tag === "arriving") return { crop: "seeded" };
      if (h.phase._tag === "working" && h.phase.retry !== undefined) return { crop: growth(h), badge: badgeRetrying() };
      // Another round after a failed acceptance: it works on what the review said.
      const open = openFindings(issue);
      return open > 0 ? { crop: "weeds", badge: { text: t("server.game.badge.weeding", { n: open }), tone: "bug" } } : { crop: growth(h) };
    }
    case "asking":
      return { crop: "dry", badge: badgeQuestions() };
    case "reviewing":
      if (issue.reviewedAt !== undefined) return { crop: ripeCrop(h), badge: badgeRipe() };
      // One its task graph acts on asks nothing of the owner here.
      return a.acts.length > 0 ? { crop: "flowering", badge: badgeReview() } : { crop: "flowering" };
    case "stuck":
      switch (a.stuck) {
        case "conflict":
          return { crop: "withered", badge: badgeConflict() };
        case "failed":
        case undefined:
          return { crop: "withered", badge: badgeBugs() };
        case "interrupted":
          return { crop: growth(h), badge: badgeHalfway() };
        case "quiet":
          return { crop: "dry", badge: badgeQuiet() };
      }
      break;
    case "done":
    case "canceled":
      break;
  }
  return plotOfSession(h);
}

/** A session that works no issue (a draft, the one splitting a task graph): its own phase is all there is. */
export function plotOfSession(h: Session): PlotView {
  const need = needOf(h);
  const conflict = need?.kind === "conflict";
  switch (h.phase._tag) {
    case "arriving":
      return { crop: "seeded" };
    case "working":
      if (need?.kind === "quiet") return { crop: "dry", badge: badgeQuiet() };
      if (need?.kind === "retrying") return { crop: growth(h), badge: badgeRetrying() };
      return { crop: growth(h) };
    case "done":
      return { crop: ripeCrop(h), badge: conflict ? badgeConflict() : badgeRipe() };
    case "failed":
      return { crop: "withered", badge: badgeBugs() };
    case "resting":
      return { crop: growth(h), badge: conflict ? badgeConflict() : badgeRest() };
    case "closed":
      break;
  }
  return { crop: "empty" };
}

/** None on a farm's first count. */
export function levelUps(before: number | undefined, after: number): GameEffect[] {
  if (before === undefined) return [];
  const out: GameEffect[] = [];
  const [from] = levelForCommits(before);
  const [to] = levelForCommits(after);
  for (let level = from + 1; level <= to; level++) out.push({ kind: "levelUp", level });
  return out;
}

export function effectsOf(before: WorkspaceState, fact: Fact): GameEffect[] {
  switch (fact.type) {
    case "commits":
      return levelUps(before.commits?.total, fact.commits.total);
    case "progress": {
      const news = fact.news;
      if (!news) return [];
      const out: GameEffect[] = [];
      if (news.coins != null && news.coins !== 0)
        out.push({ kind: "reward", ...(news.session ? { sessionId: news.session } : {}), coins: news.coins, streak: fact.progress.streak });
      for (const u of news.unlocked) out.push(achievementEffect(u.id, u.tier));
      return out;
    }
    case "report":
      return fact.outcome === "failed" && sessionOf(before, fact.id) ? [{ kind: "penalty", sessionId: fact.id }] : [];
    default:
      break;
  }
  return [];
}

export function viewOf(state: WorkspaceState): FarmView {
  const plots: Record<string, PlotView> = {};
  for (const h of state.sessions)
    plots[h.id] = plotOf(
      h,
      state.issues.find((item) => item.id === h.issue),
    );
  return { level: farmLevelOf(state), plots, achievements: standingsOf(state.progress) };
}

export function achievementInWords(a: AchievementDef): Achievement {
  const tiers: AchievementTier[] = a.tiers.map((need, i) => ({ need, title: tierTitle(a, i + 1), coins: a.coins[i] ?? 0, reached: reachedText(a, i + 1) }));
  return omitUndefined({ id: a.id, category: a.category, title: a.title, detail: a.detail, unit: a.unit, wearable: a.category !== "starter", tiers });
}

function tierTitle(a: AchievementDef, tier: number): string {
  const titles = a.tierTitles ?? [];
  if (tier >= 1 && tier <= titles.length) return titles[tier - 1]!;
  return tier === 2 ? t("server.game.tier.silver", { title: a.title }) : tier === 3 ? t("server.game.tier.gold", { title: a.title }) : a.title;
}

function reachedText(a: AchievementDef, tier: number): string {
  if (a.category === "starter") return t("server.game.reached.starter");
  if (a.category === "secret") return t("server.game.reached.secret");
  return tier === 3 ? t("server.game.reached.gold") : tier === 2 ? t("server.game.reached.silver") : t("server.game.reached.unlocked");
}

function achievementEffect(id: string, tier: number): GameEffectAchievement {
  const e: GameEffectAchievement = { kind: "achievement", achievement: id, tier, title: "", reached: "", detail: "", coins: 0, oneOff: false };
  for (const a of achievements()) {
    if (a.id !== id) continue;
    const words = achievementInWords(a);
    e.detail = a.detail;
    e.oneOff = a.tiers.length === 1;
    const item = tier >= 1 && tier <= words.tiers.length ? words.tiers[tier - 1] : undefined;
    if (item) Object.assign(e, { title: item.title, reached: item.reached, coins: item.coins });
  }
  return e;
}

function standingsOf(p: Progress | undefined): AchievementStanding[] {
  return achievements().map((a) => {
    const s: AchievementStanding = { id: a.id, tier: 0, count: 0 };
    if (p) {
      s.count = p.counts[a.id] ?? 0;
      for (const u of p.unlocked) if (u.id === a.id && u.tier > s.tier) s.tier = u.tier;
    }
    const next = a.tiers[s.tier];
    if (next !== undefined) s.next = next;
    return s;
  });
}
