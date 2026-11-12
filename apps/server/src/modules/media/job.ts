import type { z } from "zod";

import { abortable, anySignal, type Clock } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { MediaPhaseValues, MediaUnderstandingPhaseValues } from "@vibevalley/protocol";

import type { ApiError } from "#/base/errors.ts";
import { jsonOrNone } from "#/base/json.ts";
import type * as q from "#db/media_job.sql.ts";

/** Every phase a media job of some kind can be in. */
export type MediaJobPhase = T.MediaPhase | T.MediaUnderstandingPhase;
export const mediaJobPhases: readonly MediaJobPhase[] = [...new Set<MediaJobPhase>([...MediaPhaseValues, ...MediaUnderstandingPhaseValues])];

/** A media_job row as one kind's code reads it: its phase is one that kind has. */
export type JobRow<P extends string> = Omit<q.MediaJobResult, "phase"> & { readonly phase: P };

/** Any job, as the machine reads it. */
export type Row = JobRow<MediaJobPhase>;

/** How one kind's code reads media_job: a row is its own only if it is one of its kinds with a phase it has; another
 * kind's job (or a phase it cannot have) is not its. */
export const jobsOf = <P extends string>({ kinds, phases }: { readonly kinds: readonly string[]; readonly phases: readonly P[] }) => {
  const one = (row: (Omit<q.MediaJobResult, "phase"> & { readonly phase: string }) | undefined): JobRow<P> | undefined => {
    if (row === undefined || !kinds.includes(row.kind)) return undefined;
    const phase = phases.find((p) => p === row.phase);
    return phase === undefined ? undefined : { ...row, phase };
  };
  return {
    one,
    many: (rows: readonly q.MediaJobResult[]): JobRow<P>[] => rows.flatMap((row) => one(row) ?? []),
  };
};

type Optional = "input" | "inputs" | "fingerprint" | "authorization" | "cleanup";

/** A new job's row: the columns other kinds use are left to their defaults. */
export const newJob = (job: Omit<q.InsertMediaJobParams, Optional> & Partial<Pick<q.InsertMediaJobParams, Optional>>): q.InsertMediaJobParams => ({
  input: null,
  inputs: null,
  fingerprint: null,
  authorization: null,
  cleanup: null,
  ...job,
});

/** A JSON column read with schema; a value that does not read is refused as the caller says (a corrupt job), not a defect. */
export const storedAs =
  <A>(schema: z.ZodType<A>, refusal: () => ApiError) =>
  (text: string): A => {
    const got = jsonOrNone(schema)(text);
    if (got === undefined) throw refusal();
    return got;
  };

/** work under a deadline: past ms its signal aborts, and once work has ended (cleaned up after itself) it rejects with
 * what timedOut gives. The caller's own abort goes on as it is. */
export async function inTime<A>(
  work: (signal: AbortSignal) => Promise<A>,
  ms: number,
  options: { readonly clock: Clock; readonly signal?: AbortSignal | undefined; readonly timedOut: () => unknown },
): Promise<A> {
  const deadline = new AbortController();
  const stop = new AbortController();
  options.clock.sleep(ms, stop.signal).then(
    () => deadline.abort(options.timedOut()),
    () => undefined,
  );
  try {
    return await work(anySignal(deadline.signal, options.signal));
  } catch (e) {
    if (deadline.signal.aborted && options.signal?.aborted !== true) throw deadline.signal.reason;
    throw e;
  } finally {
    stop.abort();
  }
}

/** A response body's chunks; the body is canceled when the signal aborts, so a stalled one ends. */
export async function* bodyChunks(response: Response, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  if (response.body === null) return;
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const cancel = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  let ended = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        ended = true;
        return;
      }
      yield value;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!ended) cancel();
  }
}

/** Each value of source, given up when signal aborts even while the source is stalled. */
export async function* untilAborted<A>(source: AsyncIterable<A>, signal: AbortSignal): AsyncGenerator<A> {
  const it = source[Symbol.asyncIterator]();
  let ended = false;
  try {
    for (;;) {
      // Checked first: abortable does not wait on a next() asked for after the abort, and its failure would go unheard.
      signal.throwIfAborted();
      const next = await abortable(it.next(), signal);
      if (next.done === true) {
        ended = true;
        return;
      }
      yield next.value;
    }
  } finally {
    // A stalled source never answers return(): it is told to stop and not waited for.
    if (!ended) void Promise.resolve(it.return?.()).catch(() => undefined);
  }
}
