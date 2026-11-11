import { Schema } from "effect";

import type { Codec } from "../codec";
import { ActorKind, SessionId } from "../common/schema";
import { MemorySourceInfo } from "../setting/schema";
import * as T from "./shapes";

export const RecallPreview: Codec<T.RecallPreview> = Schema.Struct({
  lines: Schema.mutable(Schema.Array(Schema.String)),
  chars: Schema.Finite,
  limit: Schema.Finite,
});

const ArchiveFile: Codec<T.ArchiveFile> = Schema.Struct({
  name: Schema.String,
  at: Schema.Finite,
  chars: Schema.Finite,
});

const ArchiveHit: Codec<T.ArchiveHit> = Schema.Struct({
  file: Schema.String,
  line: Schema.Finite,
  text: Schema.String,
});

export const ArchiveListing: Codec<T.ArchiveListing> = Schema.Struct({
  files: Schema.mutable(Schema.Array(ArchiveFile)),
  hits: Schema.mutable(Schema.Array(ArchiveHit)),
});

const MemoryKind: Codec<T.MemoryKind> = Schema.Literals(T.MemoryKindValues);

/** A memory's fields; a found one (MemoryFound) has them and more. */
const memoryFields = {
  id: Schema.String,
  agent: Schema.String,
  kind: MemoryKind,
  text: Schema.String,
  author: ActorKind,
  repo: Schema.optionalKey(Schema.String),
  session: Schema.optionalKey(SessionId),
  at: Schema.Finite,
  recalled: Schema.Finite,
  recalledAt: Schema.optionalKey(Schema.Finite),
  fading: Schema.Boolean,
  source: Schema.optionalKey(Schema.String),
};

export const Memory: Codec<T.Memory> = Schema.Struct(memoryFields);

export const MemoryRequest: Codec<T.MemoryRequest> = Schema.Struct({
  text: Schema.String,
  repo: Schema.optionalKey(Schema.String),
  requestKey: Schema.optionalKey(Schema.String),
});

const MemoryScope: Codec<T.MemoryScope> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("repo"), repo: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
]);

const MemoryFound: Codec<T.MemoryFound> = Schema.Struct({ ...memoryFields, source: Schema.String, score: Schema.Finite, scope: MemoryScope });

export const MemorySearch: Codec<T.MemorySearch> = Schema.Struct({
  found: Schema.mutable(Schema.Array(MemoryFound)),
  coverage: Schema.mutable(Schema.Array(Schema.String)),
});

export const MemoryList: Codec<T.MemoryList> = Schema.Struct({
  memories: Schema.mutable(Schema.Array(Memory)),
  sources: Schema.mutable(Schema.Array(MemorySourceInfo)),
});
