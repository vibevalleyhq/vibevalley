import { dagLayers } from "@vibevalley/agent/dag";
import { everyone, defaultOrchestrator, ownerId } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";
import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { type AchievementDef, achievements } from "#/agent/seed.ts";
import { sessionOf, sessionOnIssue } from "#/session/roster.ts";

import { achievementInWords, levelForCommits } from "./view.ts";

/** An entry as a fact makes it: when is the clock's, set as it is written. */
export type Entry = T.LedgerEntry extends infer E ? (E extends T.LedgerEntry ? Omit<E, "at"> : never) : never;

const achievementOf = (id: string) => achievements().find((a) => a.id === id);

const isTitle = (a: AchievementDef) => a.category !== "starter";

const tierOf = (p: T.Progress, id: string) => p.unlocked.reduce((t, u) => (u.id === id && u.tier > t ? u.tier : t), 0);

/** What reaching that tier (from 1) pays: seeds.json says, for each achievement. */
const tierCoins = (a: AchievementDef, tier: number) => (tier >= 1 ? (a.coins[tier - 1] ?? 0) : 0);

const streakMultiplier = (streak: number) => Math.min(2, 1 + 0.1 * Math.max(0, streak - 1));

export const harvestCoins = (commits: number, streak: number) => Math.round((30 + Math.min(commits * 5, 30)) * streakMultiplier(streak));

const taskCoins = (merged: number) => 30 + 10 * merged;

/** Under this, a harvested issue is cheap . */
const cheapCNY = 0.05;

interface Seen {
  readonly told: readonly string[];
  readonly failed: readonly string[];
  readonly conflicted: readonly string[];
  readonly reviewed: readonly string[];
  readonly runtimes: readonly string[];
}

export interface Folded {
  readonly progress: T.Progress;
  readonly seen: Seen;
}

export const emptyProgress = (): T.Progress => ({ coins: 0, streak: 0, bestStreak: 0, counts: {}, unlocked: [], multiplier: 1, agents: {} });

export const emptyFolded = (): Folded => ({ progress: emptyProgress(), seen: { told: [], failed: [], conflicted: [], reviewed: [], runtimes: [] } });

const added = (list: readonly string[], item: string): readonly string[] => (list.includes(item) ? list : [...list, item]);
const bump = (counts: Record<string, number>, id: string, by: number) => ({ ...counts, [id]: (counts[id] ?? 0) + by });
const atLeast = (counts: Record<string, number>, id: string, value: number) => ((counts[id] ?? 0) >= value ? counts : { ...counts, [id]: value });

function tallied(p: T.Progress, e: T.LedgerEntry): T.Progress {
  const field = e.kind === "hired" ? "hired" : e.kind === "harvested" ? "harvested" : e.kind === "failed" ? "failed" : undefined;
  const agent = field && "agent" in e ? e.agent : undefined;
  if (!field || !agent) return p;
  const was = p.agents[agent] ?? { hired: 0, harvested: 0, failed: 0 };
  return { ...p, agents: { ...p.agents, [agent]: { ...was, [field]: was[field] + 1 } } };
}

/** Night and weekend are told in the server's own time zone, as JavaScript's Date does. */
export function progressStep(folded: Folded, entry: T.LedgerEntry): [Folded, T.ProgressNews] {
  let p = folded.progress;
  let seen = folded.seen;
  let counts = p.counts;
  let coins = 0;
  let session: T.SessionId | undefined;
  const at = entry.at;
  switch (entry.kind) {
    case "harvested": {
      const streak = p.streak + 1;
      p = { ...p, streak, bestStreak: Math.max(p.bestStreak, streak) };
      coins += harvestCoins(entry.commits, streak);
      session = entry.session;
      const told = seen.told.includes(entry.session);
      const failed = seen.failed.includes(entry.session);
      counts = bump(counts, "harvests", 1);
      if (entry.runs <= 1 && !told && !failed) counts = bump(counts, "first_try", 1);
      if (seen.conflicted.includes(entry.session)) counts = bump(counts, "untangle", 1);
      if (failed) counts = bump(counts, "comeback", 1);
      if (entry.cny !== undefined && entry.cny < cheapCNY) counts = bump(counts, "thrifty", 1);
      if (seen.reviewed.includes(entry.session)) counts = atLeast(counts, "s_review", 1);
      seen = { ...seen, runtimes: added(seen.runtimes, entry.runtime) };
      counts = { ...counts, every_machine: seen.runtimes.length };
      const when = new Date(entry.at);
      if (when.getHours() < 5) counts = atLeast(counts, "night_owl", 1);
      if (when.getDay() === 0 || when.getDay() === 6) counts = atLeast(counts, "weekend", 1);
      break;
    }
    case "failed":
      p = { ...p, streak: 0 };
      seen = { ...seen, failed: added(seen.failed, entry.session) };
      break;
    case "conflicted":
      seen = { ...seen, conflicted: added(seen.conflicted, entry.session) };
      break;
    case "told":
      seen = { ...seen, told: added(seen.told, entry.session) };
      counts = atLeast(counts, "s_tell", 1);
      break;
    case "reviewed":
      seen = { ...seen, reviewed: added(seen.reviewed, entry.session) };
      break;
    case "family":
      coins += taskCoins(entry.merged);
      counts = atLeast(counts, "big_graph", entry.merged);
      if (entry.parallel) counts = bump(counts, "parallel_graph", 1);
      break;
    case "handoff":
      counts = bump(counts, "handoff", 1);
      break;
    case "called":
      counts = atLeast(counts, "s_call", 1);
      break;
    case "hired":
      counts = atLeast(counts, "s_hire", 1);
      break;
    case "opened":
      counts = atLeast(counts, "s_open", 1);
      break;
    case "split":
      counts = atLeast(counts, "s_split", 1);
      break;
    case "voice":
      counts = atLeast(counts, "s_voice", 1);
      break;
    case "busy6":
      counts = atLeast(counts, "full_house", 1);
      break;
    case "level":
      counts = atLeast(counts, "farm_level", entry.level);
      break;
    case "titled": {
      // Only a tier reached can be worn, and not a starter task's; anything else takes the title off.
      const { title: _, ...untitled } = p;
      p = untitled;
      const tier = entry.tier;
      const worn = entry.achievement && tier != null && tier !== 0 ? achievementOf(entry.achievement) : undefined;
      if (worn && tier != null && tier !== 0 && isTitle(worn) && tierOf(p, worn.id) >= tier) p = { ...p, title: { id: worn.id, tier } };
      break;
    }
  }
  counts = atLeast(counts, "steady", p.bestStreak);

  // Tiers reached by this entry: each earns its coins once.
  const unlocked: T.Unlock[] = [];
  for (const a of achievements()) {
    const count = counts[a.id] ?? 0;
    const had = tierOf(p, a.id);
    a.tiers.forEach((need, i) => {
      const tier = i + 1;
      if (tier > had && count >= need) {
        unlocked.push({ id: a.id, tier, at });
        coins += tierCoins(a, tier);
      }
    });
  }
  const next: T.Progress = { ...tallied(p, entry), coins: p.coins + coins, counts, unlocked: [...p.unlocked, ...unlocked] };
  next.multiplier = streakMultiplier(next.streak);
  const news: T.ProgressNews = { ...(coins !== 0 ? { coins } : {}), ...(session ? { session } : {}), unlocked };
  return [{ progress: next, seen }, news];
}

export const progressFold = (entries: readonly T.LedgerEntry[], from: Folded = emptyFolded()) => entries.reduce((f, e) => progressStep(f, e)[0], from);

const fullHouse = 6;

const working = (state: T.SpaceState) => state.sessions.filter((h) => h.role === "worker" && h.phase._tag === "working").length;

function familyEntry(id: string, children: readonly T.Issue[]): Entry {
  const merged = new Set<string>(children.filter((issue) => issue.delivered === "merged_into_parent").map((issue) => issue.id));
  const parallel = dagLayers(children.map((issue) => ({ id: issue.id, after: issue.blockedBy }))).some(
    (layer) => layer.filter((id) => merged.has(id)).length >= 2,
  );
  return { kind: "family", issue: id, merged: merged.size, parallel };
}

/** Only what the person does in the app (a voice call, a review, a title) is recorded where it happens: everything the
 * farm does is told by its facts. */
export function entriesFor(before: T.SpaceState, fact: T.Fact, after: T.SpaceState): Entry[] {
  const out: Entry[] = [];
  switch (fact.type) {
    case "sessionReported": {
      const h = sessionOf(after, fact.id) ?? sessionOf(before, fact.id);
      if (h?.role === "orchestrator") break;
      if (fact.outcome === "failed") out.push({ kind: "failed", session: fact.id, ...(h?.agent ? { agent: h.agent } : {}) });
      break;
    }
    case "callChanged":
      if (fact.state === "live") out.push({ kind: "opened" });
      break;
    case "sessionChanged":
      if (fact.session.role === "worker") out.push({ kind: "hired", session: fact.session.id, agent: fact.session.agent });
      break;
    case "issueChanged": {
      const issue = fact.issue;
      const previous = before.issues.find((item) => item.id === issue.id);
      const session = latestSessionIdOf(issue);
      if (issue.conflict && session && (!previous?.conflict || latestSessionIdOf(previous) !== session)) out.push({ kind: "conflicted", session });
      if (issue.parent && !before.issues.some((item) => item.parent === issue.parent)) out.push({ kind: "split" });
      const children = after.issues.filter((item) => item.parent === issue.id);
      if (issue.status === "done" && before.issues.find((item) => item.id === issue.id)?.status !== "done" && children.length > 0) {
        out.push(familyEntry(issue.id, children));
      }
      break;
    }
    case "sessionLeft": {
      // Harvested: only when something went into the main branch, which is what earns.
      const h = sessionOf(before, fact.id);
      if (h && fact.closed === "merged" && fact.merged != null && fact.merged > 0)
        out.push({
          kind: "harvested",
          session: fact.id,
          agent: h.agent,
          repo: h.repo ?? "",
          runtime: h.runtime,
          commits: fact.merged,
          ...(h.spent?.cny !== undefined ? { cny: h.spent.cny } : {}),
          runs: h.runs,
        });
      break;
    }
    case "messageChanged": {
      if (fact.message.fromKind === "owner") {
        if (fact.thread) {
          const h = sessionOnIssue(before, fact.thread);
          if (h) out.push({ kind: "told", session: h.id });
        }
        for (const named of fact.message.mentions) {
          const h = named !== defaultOrchestrator && named !== ownerId && named !== everyone ? sessionOf(before, named) : undefined;
          if (h) out.push({ kind: "called", session: h.id });
        }
      } else if (fact.message.fromKind === "session" && fact.answers) out.push({ kind: "handoff", session: fact.answers, to: fact.message.from });
      break;
    }
    case "progressChanged": {
      if (fact.commits) {
        const [level] = levelForCommits(fact.commits.total);
        const [was] = levelForCommits(before.commits?.total ?? 0);
        if (level > was) out.push({ kind: "level", level });
      }
      break;
    }
    default:
      break;
  }
  // Six beds busy: once for each time the farm fills up.
  if (working(before) < fullHouse && working(after) >= fullHouse) out.push({ kind: "busy6" });
  return out;
}

/** A farm level the ledger has not told yet, from commits counted before it. */
export function catchUp(state: T.SpaceState): Entry[] {
  const [level] = levelForCommits(state.commits?.total ?? 0);
  const known = state.progress?.counts.farm_level ?? 1;
  return level > known ? [{ kind: "level", level }] : [];
}

/** Every achievement, in the page's order. */
export const achievementsInWords = (): T.Achievement[] => achievements().map(achievementInWords);
