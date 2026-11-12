import { type Runtime } from "@botiverse/oar";
import type { ScriptedTurn } from "@botiverse/oar/testing";

import type * as T from "@vibevalley/protocol";

import type { ServerConfig } from "#/infra/config.ts";
import type { Game } from "#/modules/game/game.ts";
import { makeOrchestrator } from "#/modules/orchestrator/orchestrator.ts";
import { type Hired } from "#/modules/session/session.ts";
import { agentSessionsBoot, channelBoot, gamification, inboxBoot, mailboxBoot, mediaBoot } from "#/services.ts";
import { gitIn } from "#/testing/git.ts";
import { starter, testConfig, until as untilHeld, waitFor } from "#/testing/layers.ts";
import { type ScriptedModel } from "#/testing/model.ts";
import { network } from "#/testing/network.ts";
import { helper } from "#/testing/worker.ts";
import { type World, world, type WorldOptions } from "#/testing/world.ts";

/** The seed profile on pi, with no effort: the scripted runtime has no models, so no effort levels. */
export const lab = (): T.Agent => ({ ...starter("lab"), effort: "" });

/** The farm a flow runs on: world, the game, and the startup of the modules in it. */
export type FlowWorld = World & { readonly game: Game };

/** World with the game, then the startup of what is in it, in module order. */
async function flowWorld(options: WorldOptions): Promise<FlowWorld> {
  const below = await world(options);
  try {
    const built = await gamification(below);
    await agentSessionsBoot(built);
    await channelBoot(built);
    await mailboxBoot(built);
    await mediaBoot(built);
    await inboxBoot(built);
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

/** What p was refused with: the test fails if it went through. */
export async function failure(p: Promise<unknown>): Promise<Error & { readonly bizCode?: unknown; readonly reason?: unknown }> {
  const settled = await p.then(
    () => undefined,
    (e: unknown) => ({ e }),
  );
  if (settled === undefined) throw new Error("expected a refusal, and it went through");
  if (!(settled.e instanceof Error)) throw new Error(`refused with something not an Error: ${String(settled.e)}`, { cause: settled.e });
  return settled.e;
}

/** The farm up to its tools on the offline vendors (testing/network.ts), and the orchestrator answering with llm; no
 * startup. */
export async function mediaFarm(llm: ScriptedModel) {
  const w = await world({ config: testConfig({ patrol: { heartbeatMinutes: 0 } }), network: network() });
  try {
    w.deepseek.use(llm);
    const orchestrator = await makeOrchestrator(w);
    w.closes.push(() => orchestrator.close());
    return Object.assign(w, { orchestrator });
  } catch (e) {
    await w.close();
    throw e;
  }
}
