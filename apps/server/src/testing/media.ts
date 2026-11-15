// What the media tests share: a clock they move, a vendor they answer as, triggers that refuse a write, and a Media of
// their own over a test farm.
import { setImmediate } from "node:timers/promises";

import { abortError } from "@vibevalley/async";

import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { keptLog } from "#/infra/log.ts";
import type { PublicFetch } from "#/infra/publicHttp.ts";
import type { Time } from "#/infra/time.ts";
import { makeInputs } from "#/modules/media/inputs.ts";
import { makeMedia } from "#/modules/media/media.ts";
import { makeProvider } from "#/platform/provider/provider.ts";

import { testConfig } from "./layers.ts";
import { world } from "./world.ts";

/** A clock that moves only when the test says, from 0; each wait it passes ends in order, and what it woke gets a few turns. */
export function heldTime() {
  let at = 0;
  const waits = new Set<{ readonly until: number; readonly wake: () => void }>();
  const time: Time = {
    now: () => at,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        const wait = { until: at + Math.max(0, ms), wake: resolve };
        waits.add(wait);
        signal?.addEventListener(
          "abort",
          () => {
            waits.delete(wait);
            reject(signal.reason ?? abortError("stopped"));
          },
          { once: true },
        );
      }),
    after: (ms, f) => {
      const wait = { until: at + Math.max(0, ms), wake: f };
      waits.add(wait);
      return () => void waits.delete(wait);
    },
  };
  const turns = async (n: number) => {
    for (let turn = 0; turn < n; turn++) await setImmediate();
  };
  /** Moves the clock ms on, ending each wait it passes in order. */
  const adjust = async (ms: number) => {
    const target = at + ms;
    for (;;) {
      const next = [...waits].filter((w) => w.until <= target).toSorted((a, b) => a.until - b.until)[0];
      if (next === undefined) break;
      waits.delete(next);
      at = Math.max(at, next.until);
      next.wake();
      await turns(5);
    }
    at = target;
    await turns(20);
  };
  return { time, adjust };
}

export const minutes = (n: number) => n * 60_000;
export const hours = (n: number) => n * 3_600_000;

/** A vendor answering each request as answer does. */
export const vendor =
  (answer: (request: Request) => Response | Promise<Response>): typeof fetch =>
  async (input, init) =>
    answer(new Request(input, init));

/** A download answering each request as answer does. */
export const downloads =
  (answer: (request: Request) => Response | Promise<Response>): PublicFetch =>
  async (url, init) =>
    answer(new Request(url, init));

/** A request that never answers: it rejects once its signal aborts, after whatever stopping waits for. */
export const never = (signal: AbortSignal | undefined, stopping: () => Promise<void> = async () => undefined) =>
  new Promise<never>((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        void stopping().then(() => reject(signal.reason));
      },
      { once: true },
    );
  });

/** No network: a request made by mistake fails the test. */
const offline: typeof fetch = async (input) => {
  throw new Error(`no network in tests: ${String(input instanceof Request ? input.url : input)}`);
};

export { allow, refuse } from "./refuse.ts";

export interface MediaFarmOptions {
  /** How the vendor answers; no network when absent. */
  readonly fetch?: typeof fetch;
  /** How a result's public address answers; no network when absent. */
  readonly publicFetch?: PublicFetch;
  readonly config?: ServerConfig;
  /** The core Media tells, in place of the farm's own (one that holds a fact up). */
  readonly core?: (core: Core) => Core;
  readonly clock?: Time;
}

/** A Media of its own, with its own Provider over the vendor the test answers as, on a test farm. */
export async function mediaFarm(options: MediaFarmOptions = {}) {
  const farm = await world({ config: options.config ?? testConfig() });
  const log = keptLog();
  const held = heldTime();
  const clock = options.clock ?? held.time;
  const provider = await makeProvider({ setting: farm.setting, fetch: options.fetch ?? offline, clock, log });
  const core = options.core?.(farm.core) ?? farm.core;
  const make = () =>
    makeMedia({
      db: farm.db,
      core,
      clock,
      log,
      attachment: farm.attachment,
      session: farm.session,
      channel: farm.channel,
      provider,
      publicFetch: options.publicFetch ?? offline,
    });
  const media = await make();
  return {
    farm,
    provider,
    media,
    clock,
    /** Moves the test's clock on (when it is the held one). */
    adjust: held.adjust,
    log,
    /** Another Media over the same farm, as after a restart. */
    again: make,
    /** Another Inputs over the same tables, beside the Media's own. */
    inputsOf: () => makeInputs({ db: farm.db, clock, log, attachment: farm.attachment }),
    [Symbol.asyncDispose]: async () => {
      await media.close();
      await farm[Symbol.asyncDispose]();
    },
  };
}
