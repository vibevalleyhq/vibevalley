import type { Attachment } from "../attachment/shapes";
import type { MediaJob } from "../media/shapes";

export const LibraryOriginKindValues = ["generated", "uploaded", "fetched"] as const;
export type LibraryOriginKind = (typeof LibraryOriginKindValues)[number];

export const LibraryFileKindValues = ["image", "audio", "video", "other"] as const;
export type LibraryFileKind = (typeof LibraryFileKindValues)[number];

/** Duplicate bytes only advance lastAt without overwriting origin. */
export type LibraryOrigin =
  | { kind: "generated"; job: string; jobKind: MediaJob["kind"] }
  | { kind: "uploaded"; channel?: string; message?: string }
  | { kind: "fetched"; agent: string; session?: string; from: { url: string } | { path: string } };

export interface LibraryItem {
  attachment: Attachment;
  origin: LibraryOrigin;
  addedAt: number;
  lastAt: number;
}

export const LibrarySortValues = ["recent", "name", "size"] as const;
export type LibrarySort = (typeof LibrarySortValues)[number];

export interface LibraryListRequest {
  origin?: LibraryOriginKind;
  type?: LibraryFileKind;
  text?: string;
  sort?: LibrarySort;
}

/** Exactly one of attachment, url, or path must be set. */
export interface LibraryAddRequest {
  attachment?: string;
  url?: string;
  path?: string;
  name?: string;
}
