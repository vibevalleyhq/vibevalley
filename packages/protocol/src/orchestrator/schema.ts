import { z } from "zod";

import type { Codec } from "../codec";
import type * as T from "./shapes";

export const OrchestratorEvalRequest = z.object({
  agent: z.exactOptional(z.string()),
  on: z.number(),
  want: z.string(),
}) satisfies Codec<T.OrchestratorEvalRequest>;

export const OrchestratorEval = z.object({
  id: z.string(),
  file: z.string(),
}) satisfies Codec<T.OrchestratorEval>;
