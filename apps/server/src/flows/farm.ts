import { type Runtime } from "@botiverse/oar";
import type { ScriptedTurn } from "@botiverse/oar/testing";

import type * as T from "@vibevalley/protocol";

import type { ServerConfig } from "#/infra/config.ts";
import type { Game } from "#/modules/game/game.ts";
import { type Hired } from "#/modules/session/session.ts";
import { agentSessionsStart, channelStart, gamification, inboxStart, mailboxReady, mediaStart } from "#/services.ts";
import { gitIn } from "#/testing/git.ts";
import { starter, testConfig, until as untilHeld, waitFor } from "#/testing/layers.ts";
import { helper } from "#/testing/worker.ts";
import { type World, world, type WorldOptions } from "#/testing/world.ts";

/** The seed profile on pi, with no effort: the scripted runtime has no models, so no effort levels. */
export const lab = (): T.Agent => ({ ...starter("lab"), effort: "" });

/** The farm a flow runs on: world, the game, and the startup of the modules in it. */
export type FlowWorld = World & { readonly game: Game };

/** World with the game, then the startup of what is in it, in module order. */
export async function flowWorld(options: WorldOptions): Promise<FlowWorld> {
  const below = await world(options);
  try {
    const built = await gamification(below);
    await agentSessionsStart(built);
    await channelStart(built);
    await mailboxReady(built);
    await mediaStart(built);
    await inboxStart(built);
    return built;
  } catch (e) {
    await below.close();
    throw e;
  }
}

export interface Farm {
  readonly config: ServerConfig;
  readonly turns: ScriptedTurn[];
  /** The farm built and started; each call builds one on the same config (a restart on the same home). */
  readonly open: () => Promise<FlowWorld>;
}

/** The farm with its one runtime, pi: testing/worker.ts's unless the test gives its own. */
export function farm(
  options: Omit<WorldOptions, "runtimes"> & {
    readonly change?: (c: ServerConfig) => ServerConfig;
    readonly runtime?: Runtime;
    readonly beforeTurn?: Parameters<typeof helper>[1];
  } = {},
): Farm {
  const base = options.config ?? testConfig();
  const config = options.change ? options.change(base) : base;
  const turns: ScriptedTurn[] = [];
  const { beforeTurn, change: _change, runtime, ...worldOptions } = options;
  return {
    config,
    turns,
    open: () => flowWorld({ ...worldOptions, config, runtimes: [runtime ?? helper(turns, beforeTurn)] }),
  };
}

type Reported = Extract<T.Fact, { type: "sessionReported" }>;

/** Every fact and notice from now on, kept as they come; it stops with the farm's core. */
export function watch(w: { readonly core: World["core"] }) {
  const facts: T.Fact[] = [];
  const notes: string[] = [];
  const events = w.core.subscribe();
  const reading = (async () => {
    for await (const e of events) {
      if (e.type === "notice") notes.push(e.text);
      else if (e.type !== "snapshot" && e.type !== "event" && e.type !== "runtime") facts.push(e);
    }
  })();
  // The reader ends when the core closes its subscriptions; nothing in it can fail.
  reading.catch(() => {});
  const reports = () => facts.filter((f): f is Reported => f.type === "sessionReported" && f.outcome !== "interrupted");
  let taken = 0;
  /** The next report not cut off by a stop, in order. */
  const nextReport = async (): Promise<Reported> => {
    await until(() => reports().length > taken, "the next report");
    return reports()[taken++]!;
  };
  return { facts, notes, nextReport, [Symbol.dispose]: () => events.close() };
}

/** Polls until ok, or fails the test after ten seconds. */
export const until = (ok: () => boolean | Promise<boolean>, what: string) => untilHeld(ok, what, 10_000);

/** The value got once ok says so. */
export const await_ = <A>(get: () => A | Promise<A>, ok: (a: A) => boolean, what: string) => waitFor(get, ok, what, 10_000);

export const mustHire = (h: Hired): T.Session => h.session;

export const git = gitIn;
