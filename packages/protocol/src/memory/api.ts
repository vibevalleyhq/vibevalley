import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const memoryDeleteInput = input({ agent: z.string(), memory: z.string() });

export interface MemoryHandlers {
  /** An agent's memories from the database and its configured sources. */
  readonly "memory.list": (a: { readonly agent: string }) => Promise<T.MemoryList>;
  /** What the agent would recall for this repo and input. */
  readonly "memory.recall": (a: { readonly agent: string; readonly repo?: string; readonly text?: string }) => Promise<T.RecallPreview>;
  readonly "memory.create": (a: { readonly agent: string } & T.MemoryRequest) => Promise<T.Memory>;
  /** Memories whose words match, from every source the agent has; none named is every profile's. */
  readonly "memory.search": (a: { readonly agent?: string; readonly repo?: string; readonly text?: string }) => Promise<T.MemorySearch>;
  readonly "memory.delete": (a: { readonly agent: string; readonly memory: string }) => Promise<void>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "memory.previewDelete": (a: { readonly agent: string; readonly memory: string }) => Promise<T.Preview>;
}

export const memoryEndpoints: readonly Endpoint[] = [
  {
    op: "memory.list",
    about: ["agent"],
    input: input({ agent: z.string() }),
    result: S.MemoryList,
    can: ["user", "remote"],
  },
  {
    op: "memory.recall",
    about: ["agent"],
    input: input({ agent: z.string(), repo: z.exactOptional(z.string()), text: z.exactOptional(z.string()) }),
    result: S.RecallPreview,
    can: ["user", "remote"],
  },
  {
    op: "memory.create",
    about: ["agent"],
    input: input({ agent: z.string() }, S.MemoryRequest),
    result: S.Memory,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "memory.search",
    about: [],
    input: input({ agent: z.exactOptional(z.string()), repo: z.exactOptional(z.string()), text: z.exactOptional(z.string()) }),
    result: S.MemorySearch,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "memory.delete",
    about: ["agent", "memory"],
    input: memoryDeleteInput,
    result: undefined,
    can: ["user", "remote"],
    dryRun: "memory.previewDelete",
  },
  {
    op: "memory.previewDelete",
    about: ["agent", "memory"],
    input: memoryDeleteInput,
    result: S.Preview,
    can: ["user", "remote"],
  },
];
