import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const memoryDeleteInput = input({ agent: Schema.String, memory: Schema.String });

export interface MemoryHandlers<R = never> {
  /** An agent's memories from the database and its configured sources. */
  readonly "memory.list": (a: { readonly agent: string }) => Effect.Effect<T.MemoryList, ApiError, R>;
  /** What the agent would recall for this repo and input. */
  readonly "memory.recall": (a: { readonly agent: string; readonly repo?: string; readonly text?: string }) => Effect.Effect<T.RecallPreview, ApiError, R>;
  readonly "memory.create": (a: { readonly agent: string } & T.MemoryRequest) => Effect.Effect<T.Memory, ApiError, R>;
  /** Memories whose words match, from every source the agent has; none named is every profile's. */
  readonly "memory.search": (a: { readonly agent?: string; readonly repo?: string; readonly text?: string }) => Effect.Effect<T.MemorySearch, ApiError, R>;
  readonly "memory.delete": (a: { readonly agent: string; readonly memory: string }) => Effect.Effect<void, ApiError, R>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "memory.previewDelete": (a: { readonly agent: string; readonly memory: string }) => Effect.Effect<T.Preview, ApiError, R>;
}

export const memoryEndpoints: readonly Endpoint[] = [
  {
    op: "memory.list",
    about: ["agent"],
    input: input({ agent: Schema.String }),
    result: S.MemoryList,
    can: ["owner", "remote"],
  },
  {
    op: "memory.recall",
    about: ["agent"],
    input: input({ agent: Schema.String, repo: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) }),
    result: S.RecallPreview,
    can: ["owner", "remote"],
  },
  {
    op: "memory.create",
    about: ["agent"],
    input: input({ agent: Schema.String }, S.MemoryRequest),
    result: S.Memory,
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "memory.search",
    about: [],
    input: input({ agent: Schema.optionalKey(Schema.String), repo: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) }),
    result: S.MemorySearch,
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "memory.delete",
    about: ["agent", "memory"],
    input: memoryDeleteInput,
    result: undefined,
    can: ["owner", "remote"],
    dryRun: "memory.previewDelete",
  },
  {
    op: "memory.previewDelete",
    about: ["agent", "memory"],
    input: memoryDeleteInput,
    result: S.Preview,
    can: ["owner", "remote"],
  },
];
