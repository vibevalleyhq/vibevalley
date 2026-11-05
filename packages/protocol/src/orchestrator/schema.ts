import { Schema } from "effect";

import type { Codec } from "../codec";
import type * as T from "../shapes";

export const OrchestratorEvalRequest: Codec<T.OrchestratorEvalRequest> = Schema.Struct({
  agent: Schema.optionalKey(Schema.String),
  on: Schema.Finite,
  want: Schema.String,
});

export const OrchestratorEval: Codec<T.OrchestratorEval> = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
});
