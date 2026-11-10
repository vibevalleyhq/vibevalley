import { Array as Arr, Option, Result } from "effect";

import type * as T from "@vibevalley/protocol";
import { MediaPhaseValues, MediaUnderstandingPhaseValues } from "@vibevalley/protocol";

import type * as q from "#db/media_job.sql.ts";

/** Every phase a media job of some kind can be in. */
export type MediaJobPhase = T.MediaPhase | T.MediaUnderstandingPhase;
export const mediaJobPhases: readonly MediaJobPhase[] = Arr.union(MediaPhaseValues, MediaUnderstandingPhaseValues);

/** A media_job row as one kind's code reads it: its phase is one that kind has. */
export type JobRow<P extends string> = Omit<q.MediaJobResult, "phase"> & { readonly phase: P };

/** Any job, as the machine reads it. */
export type Row = JobRow<MediaJobPhase>;

/** How one kind's code reads media_job: a row is its own only if it is one of its kinds with a phase it has; another
 * kind's job (or a phase it cannot have) is not its. */
export const jobsOf = <P extends string>({ kinds, phases }: { readonly kinds: readonly string[]; readonly phases: readonly P[] }) => {
  const one = (row: (Omit<q.MediaJobResult, "phase"> & { readonly phase: string }) | undefined): JobRow<P> | undefined => {
    if (row === undefined || !Arr.contains(kinds, row.kind)) return undefined;
    const phase = Option.getOrUndefined(Arr.findFirst(phases, (p) => p === row.phase));
    return phase === undefined ? undefined : { ...row, phase };
  };
  return {
    one,
    many: (rows: readonly q.MediaJobResult[]): JobRow<P>[] =>
      Arr.filterMap(rows, (row) => {
        const read = one(row);
        return read === undefined ? Result.failVoid : Result.succeed(read);
      }),
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
