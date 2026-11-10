import type { Attachment } from "../attachment/shapes";
import type { MediaJob } from "../media/shapes";

export const LibraryOriginKindValues = ["generated", "uploaded", "fetched"] as const;
export type LibraryOriginKind = (typeof LibraryOriginKindValues)[number];

/** What a file is, by its media type: image/…, audio/…, video/…, and everything else. */
export const LibraryFileKindValues = ["image", "audio", "video", "other"] as const;
export type LibraryFileKind = (typeof LibraryFileKindValues)[number];

/** Where an item first came from; a later arrival of the same bytes only moves lastAt. */
export type LibraryOrigin =
  | { kind: "generated"; job: string; jobKind: MediaJob["kind"] }
  /** The user's: said with in a chat message, or (neither) uploaded on the library page. */
  | { kind: "uploaded"; channel?: string; message?: string }
  /** A profile's (and its helper's session, when a helper) fetch: from a public address, or a file in its working directory. */
  | { kind: "fetched"; agent: string; session?: string; from: { url: string } | { path: string } };

export interface LibraryItem {
  attachment: Attachment;
  origin: LibraryOrigin;
  addedAt: number;
  lastAt: number;
}

export interface LibraryListRequest {
  origin?: LibraryOriginKind;
  type?: LibraryFileKind;
}

/** Exactly one of: an attachment already kept (the user's upload), a public https address, or a file in the caller's working directory. */
export interface LibraryAddRequest {
  attachment?: string;
  url?: string;
  path?: string;
  /** The name to keep it by; none: the file's own. */
  name?: string;
}
