import { z } from "zod";

import type { Codec } from "../codec";
import { ActorKind, SessionId } from "../common/schema";
import { MemorySourceInfo } from "../setting/schema";
import * as T from "./shapes";

export const RecallPreview = z.object({
  lines: z.array(z.string()),
  chars: z.number(),
  limit: z.number(),
}) satisfies Codec<T.RecallPreview>;

const ArchiveFile = z.object({
  name: z.string(),
  at: z.number(),
  chars: z.number(),
}) satisfies Codec<T.ArchiveFile>;

const ArchiveHit = z.object({
  file: z.string(),
  line: z.number(),
  text: z.string(),
}) satisfies Codec<T.ArchiveHit>;

export const ArchiveListing = z.object({
  files: z.array(ArchiveFile),
  hits: z.array(ArchiveHit),
}) satisfies Codec<T.ArchiveListing>;

const MemoryKind = z.enum(T.MemoryKindValues) satisfies Codec<T.MemoryKind>;

/** A memory's fields; a found one (MemoryFound) has them and more. */
const memoryFields = {
  id: z.string(),
  agent: z.string(),
  kind: MemoryKind,
  text: z.string(),
  author: ActorKind,
  repo: z.exactOptional(z.string()),
  session: z.exactOptional(SessionId),
  at: z.number(),
  recalled: z.number(),
  recalledAt: z.exactOptional(z.number()),
  fading: z.boolean(),
  source: z.exactOptional(z.string()),
};

export const Memory = z.object(memoryFields) satisfies Codec<T.Memory>;

export const MemoryRequest = z.object({
  text: z.string(),
  repo: z.exactOptional(z.string()),
  requestKey: z.exactOptional(z.string()),
}) satisfies Codec<T.MemoryRequest>;

const MemoryScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("repo"), repo: z.string() }),
  z.object({ kind: z.literal("unknown") }),
]) satisfies Codec<T.MemoryScope>;

const MemoryFound = z.object({ ...memoryFields, source: z.string(), score: z.number(), scope: MemoryScope }) satisfies Codec<T.MemoryFound>;

export const MemorySearch = z.object({
  found: z.array(MemoryFound),
  coverage: z.array(z.string()),
}) satisfies Codec<T.MemorySearch>;

export const MemoryList = z.object({
  memories: z.array(Memory),
  sources: z.array(MemorySourceInfo),
}) satisfies Codec<T.MemoryList>;
