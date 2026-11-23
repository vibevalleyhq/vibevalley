import { z } from "zod";

import { type Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface MachineHandlers {
  readonly "machine.list": () => Promise<T.MachineInfo[]>;
}

export const machineEndpoints: readonly Endpoint[] = [
  {
    op: "machine.list",
    about: [],
    input: undefined,
    result: z.array(S.MachineInfo),
    can: ["user", "remote"],
  },
];
