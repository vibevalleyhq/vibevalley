import { z } from "zod";

import type { Codec } from "../codec";
import type * as T from "./shapes";

export const Machine = z.object({
  id: z.string(),
  name: z.string(),
  here: z.boolean(),
  online: z.boolean(),
  joinedAt: z.number(),
}) satisfies Codec<T.Machine>;

export const FactMachineChanged = z.object({
  type: z.literal("machineChanged"),
  at: z.number(),
  machine: Machine,
}) satisfies Codec<T.FactMachineChanged>;
