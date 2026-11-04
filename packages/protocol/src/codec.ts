// A shape as it is on the wire, and the Schema type every shape's Schema is held to.

import type { Brand, Schema } from "effect";

/** A shape as it is on the wire: an id is a plain string there, branded only once read. */
export type Wire<A> = A extends Brand.Brand<string> ? Brand.Brand.Unbranded<A> : A extends object ? { [K in keyof A]: Wire<A[K]> } : A;
export type Codec<A> = Schema.Codec<A, Wire<A>>;
