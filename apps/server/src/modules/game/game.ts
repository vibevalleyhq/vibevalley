import { z } from "zod";

import { Semaphore, TaskGroup } from "@vibevalley/async";
import type { Achievement, CommitCount, LedgerEntry } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { newId } from "#/base/ids.ts";
import { jsonOrNone, jsonText } from "#/base/json.ts";
import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { type Db, SqlError } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import { isHired } from "#/modules/session/roster.ts";
import * as q from "#db/game_ledger.sql.ts";

import { achievementsInWords, catchUp, entriesFor, type Entry, type Folded, progressFold, progressStep } from "./progress.ts";

/** The person plants on an empty plot and then says what to do; the orchestrator hires a session for it some seconds later. */
const wantStationForMs = 10_000;
const countEveryMs = 2 * 60_000;
const countAfterRunMs = 15_000;

/** A ledger row's payload, and the entry it makes with the row's kind and time; a row this code cannot read any more is none. */
const payloadOf = jsonOrNone(z.unknown());

export interface Game {
  /** The achievements in words, in the page's order; how far the farm is with each goes in every frame's view. */
  readonly achievements: () => Achievement[];
  /** The title the user wears: an achievement and its tier; none of either is the plain title. */
  readonly chooseTitle: (achievement: string | undefined, tier: number | undefined) => Promise<void>;
  /** The next session hired within ten seconds goes to this station, if it is still free. */
  readonly want: (station: number) => void;
  readonly record: (entry: Entry) => Promise<void>;
  /** Commits on every repo, a repository with several worktrees once: "yours" by author email. */
  readonly count: () => Promise<CommitCount>;
  /** The count and its write, serialized with run-end refreshes. */
  readonly refresh: () => Promise<void>;
  /** How many runs' ends asked for a count. */
  readonly asked: () => number;
  /** The commits counted now and every two minutes, once the farm is up. */
  readonly boot: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface GameDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly repo: Repo;
}

export async function makeGame(deps: GameDeps): Promise<Game> {
  const { clock, config, core, repo: repos, db } = deps;
  const log = deps.log.child("game");
  const tasks = new TaskGroup({ name: "game", onError: (task, e) => log.error(`${task} failed:`, e) });

  // A row this code cannot read any more is left out of the fold.
  const rows = await q.ledgerEntries(db.sql);
  const entries: LedgerEntry[] = [];
  for (const row of rows) {
    const fields = payloadOf(row.payload);
    if (typeof fields !== "object" || fields === null) continue;
    const entry = S.LedgerEntry.safeParse({ ...fields, kind: row.kind, at: row.at });
    if (entry.success) entries.push(entry.data);
  }
  let folded: Folded = progressFold(entries);
  core.apply({ type: "progressChanged", progress: folded.progress });

  // One entry at a time, so the order in the table is the order of the fold.
  const one = new Semaphore(1);
  const record = (input: Entry): Promise<void> =>
    one.with(async () => {
      try {
        const at = clock.now();
        const entry = { ...input, at };
        const { kind, at: _, ...payload } = entry;
        await q.addLedgerEntry(db.sql, { id: newId(at), kind, at, payload: jsonText(payload) });
        const [next, news] = progressStep(folded, entry);
        folded = next;
        core.apply({ type: "progressChanged", progress: next.progress, ...((news.coins ?? 0) !== 0 || news.unlocked.length > 0 ? { news } : {}) });
      } catch (e) {
        // The farm goes on without the entry, whatever stopped it: the database's failure is the one expected.
        log.error(`vibevalley: a ledger entry (${input.kind}) was not kept${e instanceof SqlError ? "" : " (not by the database)"}`, e);
      }
    });

  const extra = config.gitEmails.map((e) => e.trim().toLowerCase()).filter((e) => e !== "");
  const count = async (): Promise<CommitCount> => {
    const counted = await repos.contributions(extra);
    return { repos: counted, total: counted.reduce((n, r) => n + r.commits, 0) };
  };
  // The ticker and a run's end both count: one at a time, so an older count never lands after a newer one.
  const counting = new Semaphore(1);
  const refresh = () => counting.with(async () => core.setCommits(await count()));
  let asked = 0;
  let pending = false;
  // Several runs share one count.
  const soon = () => {
    asked++;
    if (pending) return;
    pending = true;
    tasks.run("count after a run", async (signal) => {
      await clock.sleep(countAfterRunMs, signal);
      pending = false;
      await refresh();
    });
  };

  let wanted: { station: number; until: number } | undefined;

  const { state, changes } = core.transitions();
  for (const e of catchUp(state)) await record(e);
  tasks.run("progress", async (signal) => {
    try {
      for (let r = await changes.next(signal); r.done !== true; r = await changes.next(signal)) {
        const { before, fact, after } = r.value;
        if (fact.type === "progressChanged" && fact.commits === undefined && fact.station === undefined) continue;
        if (fact.type === "sessionReported") soon();
        if (fact.type === "sessionChanged" && isHired(fact.session)) {
          const wish = wanted;
          wanted = undefined;
          if (wish && wish.until > fact.at) core.apply({ type: "progressChanged", station: { id: fact.session.id, station: wish.station } });
        }
        for (const e of entriesFor(before, fact, after)) await record(e);
      }
    } finally {
      changes.close();
    }
  });
  const user = core.user();
  tasks.run("user", async (signal) => {
    try {
      for (let r = await user.next(signal); r.done !== true; r = await user.next(signal)) {
        const d = r.value;
        await (d.kind === "reviewed" ? record({ kind: "reviewed", session: d.session }) : record({ kind: "voice" }));
      }
    } finally {
      user.close();
    }
  });

  return {
    achievements: achievementsInWords,
    chooseTitle: (achievement, tier) => record({ kind: "titled", ...(achievement ? { achievement } : {}), ...(tier != null && tier !== 0 ? { tier } : {}) }),
    want: (station) => {
      wanted = { station, until: clock.now() + wantStationForMs };
    },
    record,
    count,
    refresh,
    asked: () => asked,
    boot: async () => {
      tasks.run("count", async (signal) => {
        while (true) {
          await refresh();
          await clock.sleep(countEveryMs, signal);
        }
      });
    },
    close: () => tasks.close(),
  };
}
