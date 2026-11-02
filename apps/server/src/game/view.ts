// What the farm draws of the core state: levels, plots,
// the effects a fact sets off, and the achievements in words.
// Where each session stands and what it has been doing is here too: no business rule reads a session's play.

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { maxRunning } from "@vibevalley/protocol";
import { farmOf, needOf, omitUndefined, plotKeyOf } from "@vibevalley/protocol/rules";

import { type AchievementDef, achievements } from "@/agent/seed.ts";
import { openFindings } from "@/issue/status.ts";
import { sessionOf } from "@/session/roster.ts";

const historyLimit = 30;

const fileLimit = 24;

const commandLimit = 12;

export const emptyPlay = (): T.SessionPlay => ({ station: -1, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] });

export const playOf = (plays: Readonly<Record<string, T.SessionPlay>> | undefined, id: string): T.SessionPlay => plays?.[id] ?? emptyPlay();

/** A free bed on `project`'s farm: `prefer` when it is free there, else the first free one, else -1. */
export function freeStation(
  plays: Readonly<Record<string, T.SessionPlay>> | undefined,
  sessions: readonly T.Session[],
  project: string,
  prefer?: number,
): number {
  const taken = new Set(sessions.filter((h) => farmOf(h) === project).map((h) => playOf(plays, h.id).station));
  if (prefer !== undefined && prefer >= 0 && prefer < maxRunning && !taken.has(prefer)) return prefer;
  for (let i = 0; i < maxRunning; i++) if (!taken.has(i)) return i;
  return -1;
}

const remember = (list: readonly string[], item: string, limit: number) => {
  const out = list.filter((x) => x !== item);
  out.push(item);
  return out.slice(Math.max(0, out.length - limit));
};

const lastN = <A>(list: readonly A[], n: number) => list.slice(Math.max(0, list.length - n));

const isToolAction = (action: T.SessionAction) =>
  action === "run_command" ||
  action === "read_file" ||
  action === "edit_file" ||
  action === "search" ||
  action === "web" ||
  action === "mcp" ||
  action === "wait" ||
  action === "other";

export const playedRun = (p: T.SessionPlay, at: number): T.SessionPlay => ({
  ...p,
  toolsThisRun: 0,
  runStartedAt: at,
  history: lastN([...p.history, { at, action: "thinking", label: "" }], historyLimit),
});

export function playedDoing(p: T.SessionPlay, f: { readonly at: number; readonly action: T.SessionAction; readonly label: string }): T.SessionPlay {
  const history = p.history;
  const last = history[history.length - 1];
  if (last && last.action === f.action && last.label === f.label) return p;
  const next: T.SessionPlay = { ...p, history: lastN([...history, { at: f.at, action: f.action, label: f.label }], historyLimit) };
  if (!isToolAction(f.action)) return next;
  next.toolsThisRun = p.toolsThisRun + 1;
  next.counts = { ...p.counts, [f.action]: (p.counts[f.action] ?? 0) + 1 };
  if ((f.action === "edit_file" || f.action === "read_file") && f.label !== "") next.files = remember(p.files, f.label, fileLimit);
  else if (f.action === "run_command" && f.label !== "") next.commands = remember(p.commands, f.label, commandLimit);
  return next;
}

/** Only to a bed that is free on its own farm; a session already there, or a bed taken, changes nothing. */
export function stationed(state: T.WorkspaceState, f: { readonly id: T.SessionId; readonly station: number }): [T.WorkspaceState, boolean] {
  const h = sessionOf(state, f.id);
  const plays = state.plays ?? {};
  const play = playOf(plays, f.id);
  if (!h || play.station === f.station) return [state, false];
  const others = state.sessions.filter((x) => x.id !== f.id);
  if (freeStation(state.plays, others, farmOf(h), f.station) !== f.station) return [state, false];
  return [{ ...state, plays: { ...plays, [f.id]: { ...play, station: f.station } } }, true];
}

const xpToNext = (level: number) => 10 * level;

export function levelForCommits(total: number): [level: number, xp: number] {
  let level = 1;
  let rest = Math.max(0, total);
  while (rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  return [level, rest];
}

function farmLevelOf(state: T.WorkspaceState): T.FarmLevel {
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
const ripeCrop = (h: T.Session): T.Crop => (fnv32a(h.id) % 2 === 1 ? "carrot" : "wheat");

function growth(h: T.Session, play: T.SessionPlay): T.Crop {
  const since = play.runStartedAt ?? h.hiredAt;
  let crop: T.Crop = "sprout";
  for (const played of play.history) {
    if (played.at < since) continue;
    if (played.action === "edit_file" && crop === "sprout") crop = "leafy";
    else if (played.action === "run_command" && crop === "leafy") crop = "flowering";
  }
  return crop;
}

// Made when asked for: their words are the locale's of the moment.
const badgeRipe = (): T.Badge => ({ text: t("server.game.badge.ripe"), tone: "ripe" });
const badgeBugs = (): T.Badge => ({ text: t("server.game.badge.bugs"), tone: "bug" });
const badgeConflict = (): T.Badge => ({ text: t("shared.stuck.conflict"), tone: "bug" });
const badgeQuiet = (): T.Badge => ({ text: t("shared.stuck.quiet"), tone: "stuck" });
const badgeHalfway = (): T.Badge => ({ text: t("shared.stuck.interrupted"), tone: "stuck" });
const badgeRetrying = (): T.Badge => ({ text: t("server.game.badge.retrying"), tone: "stuck" });
const badgeRest = (): T.Badge => ({ text: t("server.game.badge.rest"), tone: "rest" });
const badgeReview = (): T.Badge => ({ text: t("shared.stage.reviewing"), tone: "wait" });
const badgeQuestions = (): T.Badge => ({ text: t("shared.stage.asking"), tone: "wait" });

/**
 * A plot is a picture of its issue's stage, never a second reading of it: the crop and the badge say where the
 * issue stands (issueStageOf decides that, and in what order); the session only adds how far this round has grown.
 */
export function plotOf(h: T.Session, issue: T.Issue | undefined, play: T.SessionPlay): T.PlotView {
  if (!issue) return plotOfSession(h, play);
  const a = issue.stage;
  switch (a.state) {
    case "draft":
    case "queued":
    case "working": {
      if (h.phase._tag === "working" && h.phase.retry !== undefined) return { crop: growth(h, play), badge: badgeRetrying() };
      // Another round after a failed acceptance: it works on what the review said.
      const open = openFindings(issue);
      return open > 0 ? { crop: "weeds", badge: { text: t("server.game.badge.weeding", { n: open }), tone: "bug" } } : { crop: growth(h, play) };
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
          return { crop: growth(h, play), badge: badgeHalfway() };
        case "quiet":
          return { crop: "dry", badge: badgeQuiet() };
      }
      break;
    case "done":
    case "canceled":
      break;
  }
  return plotOfSession(h, play);
}

/** A session that works no issue (a draft, the one splitting a task graph): its own phase is all there is. */
function plotOfSession(h: T.Session, play: T.SessionPlay): T.PlotView {
  const need = needOf(h);
  const conflict = need?.kind === "conflict";
  switch (h.phase._tag) {
    case "working":
      if (need?.kind === "quiet") return { crop: "dry", badge: badgeQuiet() };
      if (need?.kind === "retrying") return { crop: growth(h, play), badge: badgeRetrying() };
      return { crop: growth(h, play) };
    case "done":
      return { crop: ripeCrop(h), badge: conflict ? badgeConflict() : badgeRipe() };
    case "failed":
      return { crop: "withered", badge: badgeBugs() };
    case "resting":
      return { crop: growth(h, play), badge: conflict ? badgeConflict() : badgeRest() };
    case "closed":
      break;
  }
  return { crop: "empty" };
}

/** None on a farm's first count. */
function levelUps(before: number | undefined, after: number): T.GameEffect[] {
  if (before === undefined) return [];
  const out: T.GameEffect[] = [];
  const [from] = levelForCommits(before);
  const [to] = levelForCommits(after);
  for (let level = from + 1; level <= to; level++) out.push({ kind: "levelUp", level });
  return out;
}

export function effectsOf(before: T.WorkspaceState, fact: T.Fact): T.GameEffect[] {
  switch (fact.type) {
    case "gameProgress": {
      const out: T.GameEffect[] = [];
      if (fact.commits) out.push(...levelUps(before.commits?.total, fact.commits.total));
      const news = fact.news;
      if (news && fact.progress) {
        if (news.coins != null && news.coins !== 0)
          out.push({ kind: "reward", ...(news.session ? { sessionId: news.session } : {}), coins: news.coins, streak: fact.progress.streak });
        for (const u of news.unlocked) out.push(achievementEffect(u.id, u.tier));
      }
      return out;
    }
    case "sessionReport":
      return fact.outcome === "failed" && sessionOf(before, fact.id)?.role === "worker" ? [{ kind: "penalty", sessionId: fact.id }] : [];
    default:
      break;
  }
  return [];
}

/** A plot is its issue, so a reopened issue's new session draws on the same one; if two are here, the later hired. */
export function viewOf(state: T.WorkspaceState): T.FarmView {
  const latest = new Map<string, T.Session>();
  for (const h of state.sessions) {
    if (h.role === "orchestrator") continue;
    const key = plotKeyOf(h);
    const was = latest.get(key);
    if (!was || h.hiredAt >= was.hiredAt) latest.set(key, h);
  }
  const plots: Record<string, T.PlotView> = {};
  const plays = state.plays ?? {};
  for (const [key, h] of latest)
    plots[key] = plotOf(
      h,
      state.issues.find((item) => item.id === h.issue),
      playOf(plays, h.id),
    );
  const played: Record<string, T.SessionPlayView> = {};
  for (const h of state.sessions) {
    const play = plays[h.id] ?? emptyPlay();
    played[h.id] = { ...play, history: play.history.map((step) => ({ ...step, actionText: t(`shared.action.${step.action}`) })) };
  }
  return { level: farmLevelOf(state), plots, plays: played, achievements: standingsOf(state.progress) };
}

export function achievementInWords(a: AchievementDef): T.Achievement {
  const tiers: T.AchievementTier[] = a.tiers.map((need, i) => ({ need, title: tierTitle(a, i + 1), coins: a.coins[i] ?? 0, reached: reachedText(a, i + 1) }));
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

function achievementEffect(id: string, tier: number): T.GameEffectAchievement {
  const e: T.GameEffectAchievement = { kind: "achievement", achievement: id, tier, title: "", reached: "", detail: "", coins: 0, oneOff: false };
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

function standingsOf(p: T.Progress | undefined): T.AchievementStanding[] {
  return achievements().map((a) => {
    const s: T.AchievementStanding = { id: a.id, tier: 0, count: 0 };
    if (p) {
      s.count = p.counts[a.id] ?? 0;
      for (const u of p.unlocked) if (u.id === a.id && u.tier > s.tier) s.tier = u.tier;
    }
    const next = a.tiers[s.tier];
    if (next !== undefined) s.next = next;
    return s;
  });
}
