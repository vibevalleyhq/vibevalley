import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Agent, defaultOrchestrator, type SpaceState } from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";

import type { Core } from "#/core/core.ts";
import { defaults, type ServerConfig } from "#/infra/config.ts";
import { type Db, openDb } from "#/infra/db.ts";
import { makeLogger } from "#/infra/log.ts";
import type { PublicFetch } from "#/infra/publicHttp.ts";
import { afterRealTime, type Time, wallTime } from "#/infra/time.ts";
import { withCast } from "#/modules/agent/profile.ts";
import { builtInDir, profileOf, templateFrom } from "#/modules/agent/template.ts";
import builtInIndex from "#/modules/agent/templates/index.json" with { type: "json" };

export { gate, nextTurn, until, untilGot, waitFor, whenTrue, within } from "@vibevalley/testkit/until";

/** A built-in template as a farm whose agent.starters names it has it: under the template's own id. */
export const starter = (id: string): Agent => {
  const textOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
  const t = templateFrom(textOf, join(builtInDir, id), "builtIn");
  return withCast(profileOf(t, t.id, t.name));
};

/** Every built-in template's profile but the default orchestrator's, in their order: what a test farm starts with. */
const starters = () => builtInIndex.filter((id) => id !== defaultOrchestrator);

export function testConfig(change: Partial<ServerConfig> = {}): ServerConfig {
  const home = tempDir("vibevalley-test-");
  const config = defaults(home);
  // Every listener on a free port: two farms in tests (or worktrees) never take each other's 8787, 8788, 8790.
  return {
    ...config,
    home,
    workRoot: join(home, "work"),
    db: "memory",
    port: 0,
    voice: { ...config.voice, line: { ...config.voice.line, port: 0 } },
    lan: { ...config.lan, port: 0 },
    agent: { ...config.agent, starters: starters() },
    ...change,
  };
}

/** The wall clock moved on by hand: now() is ahead by what adjust added, and a timer is due once that time comes, by
 * waiting or by adjust. A test moves the farm's day (a cron coming due, an idle session suspended) without waiting for
 * it. */
export function shiftedTime(): Time & { readonly adjust: (ms: number) => void } {
  let ahead = 0;
  const now = () => wallTime.now() + ahead;
  const due = new Set<{ readonly at: number; readonly fire: () => void }>();
  const after = (ms: number, f: () => void) => {
    const timer = { at: now() + ms, fire: () => cancel() || f() };
    const cancelReal = wallTime.after(ms, () => timer.fire());
    const cancel = () => {
      cancelReal();
      due.delete(timer);
      return false;
    };
    due.add(timer);
    return () => void cancel();
  };
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) return reject(signal.reason);
      const cancel = after(ms, () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      const onAbort = () => {
        cancel();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  return {
    now,
    sleep,
    after,
    adjust: (ms) => {
      ahead += ms;
      for (const timer of [...due]) if (timer.at <= now()) timer.fire();
    },
  };
}

/** A database of its own in memory, with the schema: closed with await using. */
export const testDb = (change: Partial<ServerConfig> = {}): Promise<Db> => openDb(testConfig(change), makeLogger({ name: "test", level: "warn" }), wallTime);

/** A fetch for a test that must not reach the network: every request fails, so one made by mistake is a failure. */
const offline: PublicFetch = (url) => Promise.reject(new Error(`no network in tests: ${String(url)}`));

const loopbackUrl = /^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/u;

/** The farm's own fetch in a test: only to this machine (the farm's own listeners), never following a redirect. */
const loopback: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!loopbackUrl.test(url)) return Promise.reject(new Error("External HTTP is disabled in server tests"));
  return globalThis.fetch(input, { redirect: "manual", ...init });
};

/** The network a test farm has: loopback for its own fetch, nothing for the public one. */
export const offlineNetwork = { fetch: loopback, publicFetch: offline } as const;

/** What pick finds in the core state: in it now, or in the first state the core moves to where it finds something. */
export async function whenState<A>(core: Core, pick: (state: SpaceState) => A | undefined | false, what: string | (() => string), ms = 5_000): Promise<A> {
  const { state, changes } = core.transitions();
  try {
    const first = pick(state);
    if (first !== undefined && first !== false) return first;
    const late = new AbortController();
    const cancel = afterRealTime(ms, () => late.abort());
    try {
      for (;;) {
        const r = await changes.next(late.signal).catch((e: unknown) => {
          if (late.signal.aborted) return undefined;
          throw e;
        });
        if (r === undefined || r.done === true) break;
        const got = pick(r.value.after);
        if (got !== undefined && got !== false) return got;
      }
    } finally {
      cancel();
    }
    throw new Error(`waited for ${typeof what === "string" ? what : what()}`);
  } finally {
    changes.close();
  }
}
