import { z } from "zod";

import { Attachment } from "../attachment/schema";
import type { Codec } from "../codec";
import { MessageId, SessionId } from "../common/schema";
import { MediaAudioKindValues } from "../media/audio-shapes";
import * as T from "./shapes";

const MediaJobKindValues = ["image", "understanding", "speech", ...MediaAudioKindValues] as const;
const JobKind = z.enum(MediaJobKindValues);

export const LibraryOrigin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generated"), job: z.string(), jobKind: JobKind }),
  z.object({ kind: z.literal("uploaded"), channel: z.exactOptional(z.string()), message: z.exactOptional(MessageId) }),
  z.object({
    kind: z.literal("fetched"),
    agent: z.string(),
    session: z.exactOptional(SessionId),
    from: z.union([z.object({ url: z.string() }), z.object({ path: z.string() })]),
  }),
]) satisfies Codec<T.LibraryOrigin>;

export const LibraryItem = z.object({
  attachment: Attachment,
  origin: LibraryOrigin,
  addedAt: z.number(),
  lastAt: z.number(),
}) satisfies Codec<T.LibraryItem>;

export const LibraryItems = z.array(LibraryItem);

export const LibraryListRequest = z.object({
  origin: z.exactOptional(z.enum(T.LibraryOriginKindValues)),
  type: z.exactOptional(z.enum(T.LibraryFileKindValues)),
  text: z.exactOptional(z.string()),
  sort: z.exactOptional(z.enum(T.LibrarySortValues)),
}) satisfies Codec<T.LibraryListRequest>;

export const LibraryAddRequest = z.object({
  attachment: z.exactOptional(z.string()),
  url: z.exactOptional(z.string()),
  path: z.exactOptional(z.string()),
  name: z.exactOptional(z.string()),
}) satisfies Codec<T.LibraryAddRequest>;
