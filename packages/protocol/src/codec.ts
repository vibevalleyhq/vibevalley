import type { z } from "zod";

import type { Branded, ParticipantId } from "./common/shapes";

/** A shape as it is on the wire: an id is a plain string there, branded or validated once read. */
export type Wire<A> = A extends Branded<string> | ParticipantId
  ? string
  : A extends readonly (infer E)[]
    ? Wire<E>[]
    : A extends object
      ? { [K in keyof A]: Wire<A[K]> }
      : A;
/** A shape's Schema: decodes the wire's form into the shape (schema.ts ties each to its hand-written type). */
export type Codec<A> = z.ZodType<A, Wire<A>>;
