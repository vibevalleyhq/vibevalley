import { Schema } from "effect";

import type { Codec } from "../codec";
import type * as T from "./shapes";

export const Machine: Codec<T.Machine> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  here: Schema.Boolean,
  online: Schema.Boolean,
  joinedAt: Schema.Finite,
});

export const FactMachineChanged: Codec<T.FactMachineChanged> = Schema.Struct({
  type: Schema.Literal("machineChanged"),
  at: Schema.Finite,
  machine: Machine,
});
