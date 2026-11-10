import { Schema } from "effect";

import { Attachment } from "../attachment/schema";
import type { Codec } from "../codec";
import * as T from "./shapes";

const JobKind = Schema.Literals(["image", "understanding", "speech", "speakers", "voiceDesign", "clone", "transcription"]);

export const LibraryOrigin: Codec<T.LibraryOrigin> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("generated"), job: Schema.String, jobKind: JobKind }),
  Schema.Struct({ kind: Schema.Literal("uploaded"), channel: Schema.optionalKey(Schema.String), message: Schema.optionalKey(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("fetched"),
    agent: Schema.String,
    session: Schema.optionalKey(Schema.String),
    from: Schema.Union([Schema.Struct({ url: Schema.String }), Schema.Struct({ path: Schema.String })]),
  }),
]);

export const LibraryItem: Codec<T.LibraryItem> = Schema.Struct({
  attachment: Attachment,
  origin: LibraryOrigin,
  addedAt: Schema.Finite,
  lastAt: Schema.Finite,
});

export const LibraryItems = Schema.mutable(Schema.Array(LibraryItem));

export const LibraryListRequest: Codec<T.LibraryListRequest> = Schema.Struct({
  origin: Schema.optionalKey(Schema.Literals(T.LibraryOriginKindValues)),
  type: Schema.optionalKey(Schema.Literals(T.LibraryFileKindValues)),
  text: Schema.optionalKey(Schema.String),
  sort: Schema.optionalKey(Schema.Literals(T.LibrarySortValues)),
});

export const LibraryAddRequest: Codec<T.LibraryAddRequest> = Schema.Struct({
  attachment: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});
